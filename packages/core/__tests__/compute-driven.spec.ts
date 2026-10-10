import { readFileSync } from "node:fs";
import { Group, PerspectiveCamera } from "three";
import { Fn } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { ComputeDrivenRegistry, type IComputeDriven } from "../src/compute-driven.js";
import { defineGame } from "../src/game.js";
import { GPUParticles3D } from "../src/particles.js";
import type { IRendererLike } from "../src/renderer.js";
import { type ICtx, Scene } from "../src/scene.js";

const renderer = {} as IRendererLike;

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

class ComputeProbe extends Group implements IComputeDriven {
  readonly warmupNodes: readonly unknown[];
  attached = 0;
  processed = 0;
  detached = 0;
  #released = false;
  readonly #order: string[];
  readonly #name: string;

  constructor(name: string, order: string[]) {
    super();
    this.#name = name;
    this.#order = order;
    this.warmupNodes = [`${name}:start`, `${name}:process`];
  }

  get released(): boolean {
    return this.#released;
  }

  attachRenderer(): void {
    this.attached += 1;
  }

  process(): void {
    this.processed += 1;
    this.#order.push(this.#name);
  }

  detach(): void {
    if (this.#released) return;
    this.#released = true;
    this.detached += 1;
  }
}

describe("ComputeDrivenRegistry", () => {
  it("documents fixed and render cadence", () => {
    const record = readFileSync(
      new URL("../../../docs/verification/PRD-242.md", import.meta.url),
      "utf8",
    );
    const normalized = record.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "Fixed-step compute remains the registry default: it dispatches once per fixed step.",
    );
    expect(normalized).toContain(
      "Render-cadence compute is an opt-in: it dispatches once per rendered frame after startup readiness.",
    );
  });

  it("defers render cadence until startup is ready", async () => {
    const canvas = testCanvas();
    const dispatched: unknown[] = [];
    let frame: ((time: number) => void) | undefined;
    const raw = {
      compute: (node: unknown) => dispatched.push(node),
      dispose: () => undefined,
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: () => undefined,
    };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    const particle = new GPUParticles3D({
      amount: 1,
      material: new SpriteNodeMaterial(),
      process: () => Fn(() => {})().compute(1),
      start: () => Fn(() => {})().compute(1),
    });
    class ParticleScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.canvasLayer.opaque = true;
        ctx.add(particle);
      }
    }
    const game = defineGame({
      renderer: { canvas, webgpuFactory: () => raw },
      scenes: { particles: ParticleScene },
      start: "particles",
    });

    try {
      await game.start();
      const ctx = game.ctx;
      if (ctx === undefined || frame === undefined) throw new Error("Game did not start its loop.");
      dispatched.length = 0;
      const ready = ctx.startup.whenReady();

      frame(16);
      expect(dispatched).toHaveLength(0);

      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      for (const time of [32, 48, 64, 80, 96]) {
        frame(time);
        await Promise.resolve();
      }
      await ready;

      frame(112);
      frame(128);
      expect(dispatched).toHaveLength(2);
    } finally {
      game.stop();
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      if (requestFrameDescriptor === undefined)
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", requestFrameDescriptor);
    }
  });

  it("keeps GPUParticles3D on render cadence when a frame has zero or multiple fixed updates", async () => {
    const canvas = testCanvas();
    const dispatched: unknown[] = [];
    let frame: ((time: number) => void) | undefined;
    const raw = {
      compute: (node: unknown) => dispatched.push(node),
      dispose: () => undefined,
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: () => undefined,
    };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    const particle = new GPUParticles3D({
      amount: 1,
      material: new SpriteNodeMaterial(),
      process: () => Fn(() => {})().compute(1),
      start: () => Fn(() => {})().compute(1),
    });
    class ParticleScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(particle);
      }
    }
    const game = defineGame({
      renderer: { canvas, webgpuFactory: () => raw },
      scenes: { particles: ParticleScene },
      start: "particles",
    });

    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not schedule a render frame.");
      dispatched.length = 0;
      const startTime = globalThis.performance?.now() ?? 0;
      frame(startTime);
      frame(startTime + 100);
      expect(dispatched).toHaveLength(2);
    } finally {
      game.stop();
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      if (requestFrameDescriptor === undefined)
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", requestFrameDescriptor);
    }
  });

  it("should dispatch a non-particle implementer once per fixed step", async () => {
    let advance: ((ticks: number) => number) | undefined;
    const order: string[] = [];
    let field: ComputeProbe | undefined;
    class ComputeScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        field = ctx.add(new ComputeProbe("field", order)) as ComputeProbe;
      }
    }
    const canvas = testCanvas();
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
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
      scenes: { compute: ComputeScene },
      start: "compute",
    });

    await game.start();
    try {
      if (advance === undefined || field === undefined)
        throw new Error("Compute probe was not attached to the game.");
      advance(3);
      expect(field.attached).toBe(1);
      expect(field.processed).toBe(3);
      expect(order).toEqual(["field", "field", "field"]);
    } finally {
      game.stop();
    }
  });

  it("should dispatch implementers in scene-add order", () => {
    const scene = new Group();
    const order: string[] = [];
    const field = new ComputeProbe("field", order);
    scene.add(field);
    const registry = new ComputeDrivenRegistry();

    registry.add(field, renderer);
    registry.process(renderer);
    registry.process(renderer);
    registry.process(renderer);

    expect(field.attached).toBe(1);
    expect(field.processed).toBe(3);
    expect(order).toEqual(["field", "field", "field"]);
    expect(registry.warmupNodes).toEqual(["field:start", "field:process"]);
  });

  it("preserves scene-add order for multiple implementers", () => {
    const scene = new Group();
    const order: string[] = [];
    const first = new ComputeProbe("first", order);
    const second = new ComputeProbe("second", order);
    const third = new ComputeProbe("third", order);
    scene.add(first, second, third);
    const registry = new ComputeDrivenRegistry();

    registry.add(first, renderer);
    registry.add(second, renderer);
    registry.add(third, renderer);
    registry.process(renderer);

    expect(order).toEqual(["first", "second", "third"]);
    expect(registry.warmupNodes).toEqual([
      "first:start",
      "first:process",
      "second:start",
      "second:process",
      "third:start",
      "third:process",
    ]);
  });

  it("should release every implementer on a scene change", async () => {
    let field: ComputeProbe | undefined;
    class FirstScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        field = ctx.add(new ComputeProbe("field", [])) as ComputeProbe;
      }
    }
    class NextScene extends Scene {
      static override readonly initialState = {};
    }
    const canvas = testCanvas();
    const game = defineGame({
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
      scenes: { first: FirstScene, next: NextScene },
      start: "first",
    });

    await game.start();
    try {
      await game.goto("next");
      expect(field?.released).toBe(true);
    } finally {
      game.stop();
    }
  });

  it("holds a destination compute scene until its kernels are warm", async () => {
    let advance: ((ticks: number) => number) | undefined;
    let finishWarmup: (() => void) | undefined;
    let warmups = 0;
    let field: ComputeProbe | undefined;
    class MenuScene extends Scene {
      static override readonly initialState = {};
    }
    class DestinationScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        field = ctx.add(new ComputeProbe("destination", [])) as ComputeProbe;
      }
    }
    const canvas = testCanvas();
    const warmupGate = new Promise<void>((resolve) => {
      finishWarmup = resolve;
    });
    const raw = {
      compileAsync: async () => undefined,
      compute: () => undefined,
      computeAsync: () => {
        warmups += 1;
        return warmupGate;
      },
      dispose: () => undefined,
      domElement: canvas,
      init: async () => undefined,
      render: () => undefined,
      setSize: () => undefined,
    };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    });
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: { canvas, webgpuFactory: () => raw },
      scenes: { destination: DestinationScene, menu: MenuScene },
      start: "menu",
      warmUp: true,
    });

    try {
      await game.start();
      if (advance === undefined) throw new Error("Game did not expose its fixed-step control.");
      const transition = game.goto("destination");
      await Promise.resolve();
      if (field === undefined || finishWarmup === undefined || warmups !== 1)
        throw new Error("Destination compute warm-up did not start.");

      advance(1);
      expect(field.processed).toBe(0);

      finishWarmup();
      await transition;
      advance(1);
      expect(field.processed).toBe(1);
    } finally {
      game.stop();
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  });

  it("releases an implementer removed from the scene and clears every remaining object", () => {
    const scene = new Group();
    const order: string[] = [];
    const removed = new ComputeProbe("removed", order);
    const remaining = new ComputeProbe("remaining", order);
    scene.add(removed, remaining);
    const registry = new ComputeDrivenRegistry();
    registry.add(removed, renderer);
    registry.add(remaining, renderer);

    scene.remove(removed);
    registry.process(renderer);
    expect(removed.released).toBe(true);
    expect(removed.processed).toBe(0);
    expect(remaining.processed).toBe(1);

    registry.clear();
    expect(remaining.released).toBe(true);
    expect(registry.size).toBe(0);
  });
});

it("forwards measured budgets only to live render-cadence candidates before dispatch", () => {
  const registry = new ComputeDrivenRegistry();
  const parent = new Group();
  const order: string[] = [];
  const render = Object.assign(new ComputeProbe("render", order), {
    processCadence: "render" as const,
    budget: { significance: () => 1, yield: vi.fn(() => order.push("yield")) },
  });
  const fixed = Object.assign(new ComputeProbe("fixed", order), {
    budget: { significance: () => 0, yield: vi.fn() },
  });
  const released = Object.assign(new ComputeProbe("released", order), {
    processCadence: "render" as const,
    budget: { significance: () => 0, yield: vi.fn() },
  });
  const detached = Object.assign(new ComputeProbe("detached", order), {
    processCadence: "render" as const,
    budget: { significance: () => 0, yield: vi.fn() },
  });
  const plain = Object.assign(new ComputeProbe("plain", order), {
    processCadence: "render" as const,
  });
  parent.add(render, fixed, released, detached, plain);
  for (const entry of [render, fixed, released, detached, plain]) registry.add(entry, renderer);
  released.detach();
  parent.remove(detached);
  registry.observeBudget({
    frames: 60,
    presented: { samples: 60, mean: 1000 / 60, p50: 0, p95: 0, p99: 0, max: 0 },
    gpuMs: 20,
    gpuCompute: 10,
    targetFps: 100,
  });
  registry.processRender(renderer);
  expect(render.budget.yield).not.toHaveBeenCalled();
  order.length = 0;
  registry.processRender(renderer, new PerspectiveCamera());
  expect(order).toEqual(["yield", "render", "plain"]);
  expect(render.budget.yield).toHaveBeenCalledExactlyOnceWith(true);
  expect(fixed.budget.yield).not.toHaveBeenCalled();
  expect(released.budget.yield).not.toHaveBeenCalled();
  expect(detached.budget.yield).not.toHaveBeenCalled();
});
