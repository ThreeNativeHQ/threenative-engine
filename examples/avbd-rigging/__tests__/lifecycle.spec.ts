import {
  ComputeDrivenRegistry,
  type IComputeDriven,
  type ICtx,
  Scene,
  defineGame,
} from "@threenative/core";
import { Group } from "three";
import { describe, expect, it, vi } from "vitest";
type IRendererLike = Parameters<IComputeDriven["process"]>[0];
import { fixture } from "./adapter-fixture.js";

describe("secondary solver through the real compute registry", () => {
  it("dispatches once per fixed call and never at render cadence or after detach", async () => {
    const f = fixture();
    await f.rigging.prepare(f.renderer);
    const scene = new Group();
    scene.add(f.rigging);
    const registry = new ComputeDrivenRegistry();
    registry.add(f.rigging, f.renderer);
    registry.process(f.renderer);
    registry.processRender(f.renderer);
    registry.process(f.renderer);
    expect(f.solver.step).toHaveBeenCalledTimes(2);
    expect(f.order[0]).toBe("snapshot");
    expect(f.order.at(-1)).toBe("step");
    scene.remove(f.rigging);
    registry.process(f.renderer);
    expect(f.solver.step).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);
    f.land?.(new ArrayBuffer(f.rigging.bodyAttribute.array.byteLength));
    await f.rigging.whenReleased();
    expect(f.device.destroy).not.toHaveBeenCalled();
    expect(f.rigging.resources).toEqual({ buffers: 0, bytes: 0, querySets: 0, sharedStorage: 0 });
  });

  it("rejects late readback from the disposed generation without populating its replacement", async () => {
    const old = fixture();
    const next = fixture();
    await old.rigging.prepare(old.renderer);
    await next.rigging.prepare(next.renderer);
    old.rigging.process(old.renderer);
    old.rigging.detach();
    next.rigging.process(next.renderer);
    old.land?.(new ArrayBuffer(old.rigging.bodyAttribute.array.byteLength));
    await old.rigging.whenReleased();
    expect(old.rigging.observation).toBeUndefined();
    expect(next.rigging.observation).toBeUndefined();
    expect(old.leases[0]?.dispose).toHaveBeenCalledTimes(1);
    next.land?.(new ArrayBuffer(next.rigging.bodyAttribute.array.byteLength));
    for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve();
    expect(next.rigging.observation?.generation).toBe(next.rigging.generation);
    next.rigging.detach();
    await next.rigging.whenReleased();
  });

  it.each(["buffer", "lease"] as const)(
    "retries a failed %s release without reviving the generation",
    async (target) => {
      const f = fixture();
      await f.rigging.prepare(f.renderer);
      const generation = f.rigging.generation;
      if (target === "buffer")
        f.buffers[0]?.originalDestroy.mockImplementationOnce(() => {
          throw new Error("busy buffer");
        });
      else
        f.leases[0]?.dispose.mockImplementationOnce(() => {
          throw new Error("busy lease");
        });
      f.rigging.detach();
      await expect(f.rigging.whenReleased()).rejects.toThrow(/TN_AVBD_RELEASE/);
      expect(f.rigging.resources.buffers + f.rigging.resources.sharedStorage).toBeGreaterThan(0);
      const retiredGeneration = f.rigging.generation;
      expect(retiredGeneration).not.toBe(generation);
      await f.rigging.retryRelease();
      expect(f.rigging.generation).toBe(retiredGeneration);
      expect(f.rigging.resources).toEqual({ buffers: 0, bytes: 0, querySets: 0, sharedStorage: 0 });
      f.rigging.process(f.renderer);
      expect(f.solver.step).not.toHaveBeenCalled();
      expect(f.device.destroy).not.toHaveBeenCalled();
    },
  );

  it("rejects finite wind whose staged shader drag overflows", async () => {
    const f = fixture({
      patches: [
        {
          name: "sail",
          columns: 2,
          rows: 2,
          width: 1,
          height: 1,
          origin: [0, 0, 0],
          totalMass: 2e-37,
          pinned: [],
        },
      ],
      ropes: [],
    });
    await f.rigging.prepare(f.renderer);
    expect(() => f.rigging.setWind(6, -Math.PI / 2, 0)).toThrow(/TN_AVBD_WIND.*Float32/);
    expect(f.solver.params.windSpeed).toBe(0);
    expect(f.solver.step).not.toHaveBeenCalled();
    f.rigging.detach();
    await f.rigging.whenReleased();
  });

  it("rejects malformed snapshots before any anchor upload or solver dispatch", async () => {
    const f = fixture();
    await f.rigging.prepare(f.renderer);
    const anchor = f.rigging.model.anchors[0];
    if (anchor === undefined) throw new Error("test anchor missing");
    anchor.position[0] = Number.NaN;
    expect(() => f.rigging.process(f.renderer)).toThrow(/TN_AVBD_SNAPSHOT/);
    expect(f.solver.setWorldAnchor).not.toHaveBeenCalled();
    expect(f.solver.step).not.toHaveBeenCalled();
    f.rigging.detach();
    await f.rigging.whenReleased();
  });

  it.each([
    { position: ["1", null, true] },
    { position: new Array(3) },
    { position: [false, 0, 0] },
  ])("rejects a malformed final anchor before any earlier upload (%j)", async ({ position }) => {
    const f = fixture(undefined, {
      readbackEveryTicks: 0,
      snapshot: (model) => ({
        anchors: model.anchors.map((a, i) =>
          i === model.anchors.length - 1
            ? (position as unknown as [number, number, number])
            : [...a.position],
        ),
        proxies: [],
      }),
    });
    await f.rigging.prepare(f.renderer);
    try {
      expect(() => f.rigging.process(f.renderer)).toThrow(/TN_AVBD_SNAPSHOT/);
      expect(f.solver.setWorldAnchor).not.toHaveBeenCalled();
      expect(f.solver.step).not.toHaveBeenCalled();
    } finally {
      f.rigging.detach();
      await f.rigging.whenReleased();
    }
  });

  it("rejects a sparse anchor list before any earlier upload", async () => {
    const f = fixture(undefined, {
      readbackEveryTicks: 0,
      snapshot: (model) => {
        const anchors = model.anchors.map((a) => [...a.position] as [number, number, number]);
        delete anchors[anchors.length - 1];
        return { anchors, proxies: [] };
      },
    });
    await f.rigging.prepare(f.renderer);
    try {
      expect(() => f.rigging.process(f.renderer)).toThrow(/TN_AVBD_SNAPSHOT/);
      expect(f.solver.setWorldAnchor).not.toHaveBeenCalled();
      expect(f.solver.step).not.toHaveBeenCalled();
    } finally {
      f.rigging.detach();
      await f.rigging.whenReleased();
    }
  });

  it("rejects adjacent fixed solver colors before attachment", async () => {
    const f = fixture(undefined, { readbackEveryTicks: 0 });
    Reflect.set(f.solver, "fixedColors", new Uint32Array(f.rigging.model.solver.bodies.length));
    try {
      await expect(f.rigging.prepare(f.renderer)).rejects.toThrow(/TN_AVBD_COLORING.*joint/);
      expect(f.rigging.resources).toEqual({ buffers: 0, bytes: 0, querySets: 0, sharedStorage: 0 });
      expect(f.solver.step).not.toHaveBeenCalled();
      expect(f.device.destroy).not.toHaveBeenCalled();
    } finally {
      f.rigging.detach();
      await f.rigging.whenReleased();
    }
  });

  it("rejects mutable dt and iteration bounds and wrong renderer identity", async () => {
    const f = fixture();
    await f.rigging.prepare(f.renderer);
    f.solver.params.dt = 0.1;
    expect(() => f.rigging.process(f.renderer)).toThrow(/TN_AVBD_FIXED_STEP/);
    expect(() => f.rigging.attachRenderer({} as IRendererLike)).toThrow(/TN_AVBD_INITIALIZATION/);
    expect(f.solver.step).not.toHaveBeenCalled();
    f.rigging.detach();
    await f.rigging.whenReleased();
  });
});

it("the actual Game fixed-step path dispatches no AVBD steps while paused or after scene replacement", async () => {
  const f = fixture(undefined, { readbackEveryTicks: 0 });
  let advance: ((ticks: number) => number) | undefined;
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientWidth: { value: 320 },
    clientHeight: { value: 180 },
    parentElement: { value: null },
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  class Active extends Scene {
    static override readonly initialState = {};
    override async load(ctx: ICtx): Promise<void> {
      ctx.renderer.storageBuffer = f.renderer.storageBuffer;
      await f.rigging.prepare(ctx.renderer);
    }
    override enter(ctx: ICtx): void {
      ctx.add(f.rigging);
    }
  }
  class Empty extends Scene {
    static override readonly initialState = {};
  }
  const game = defineGame({
    renderer: {
      canvas: canvas as HTMLCanvasElement,
      preferWebGPU: false,
      webgl2Factory: () => ({
        dispose: () => undefined,
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    },
    plugins: [
      {
        setup: (_ctx, runtime) => {
          advance = runtime?.fixedStep;
        },
      },
    ],
    scenes: { active: Active, empty: Empty },
    start: "active",
    warmUp: false,
  });
  try {
    await game.start();
    if (advance === undefined) throw new Error("test fixed-step driver missing");
    advance(3);
    expect(f.solver.step).toHaveBeenCalledTimes(3);
    game.pause();
    advance(5);
    expect(f.solver.step).toHaveBeenCalledTimes(3);
    game.resume();
    advance(2);
    expect(f.solver.step).toHaveBeenCalledTimes(5);
    await game.goto("empty");
    advance(3);
    expect(f.solver.step).toHaveBeenCalledTimes(5);
    await f.rigging.whenReleased();
    expect(f.rigging.resources).toEqual({ buffers: 0, bytes: 0, querySets: 0, sharedStorage: 0 });
    expect(f.device.destroy).not.toHaveBeenCalled();
  } finally {
    game.stop();
    vi.unstubAllGlobals();
  }
});

it("explicit post-window body observation is byte counted and rejects a retired generation", async () => {
  const f = fixture(undefined, { readbackEveryTicks: 0 });
  await f.rigging.prepare(f.renderer);
  f.rigging.process(f.renderer);
  const observed = f.rigging.observeBodies();
  expect(f.rigging.steps).toBe(1);
  f.rigging.detach();
  const rejected = expect(observed).rejects.toThrow(/TN_AVBD_READBACK_STALE/);
  f.land?.(new ArrayBuffer(f.rigging.bodyAttribute.array.byteLength));
  await rejected;
  await f.rigging.whenReleased();
  expect(f.rigging.observation).toBeUndefined();
  expect(f.rigging.resources).toEqual({ buffers: 0, bytes: 0, querySets: 0, sharedStorage: 0 });
});
