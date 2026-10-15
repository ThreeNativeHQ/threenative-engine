import { Box3, Group, Matrix4, type Object3D, PerspectiveCamera, Vector3 } from "three";
import { Fn } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticleSignificance } from "../src/particle-significance.js";
import {
  GPUParticles3D,
  type IGPUParticles3DClosedFormOptions,
  type IGPUParticles3DSpawnOptions,
  type IGPUParticles3DSpawnRequest,
  foldBounds,
} from "../src/particles.js";
import type { IRendererLike } from "../src/renderer.js";

function computeNode() {
  return Fn(() => {})().compute(1);
}

function particles(options: Partial<IGPUParticles3DClosedFormOptions> = {}) {
  return new GPUParticles3D({
    amount: 4,
    material: new SpriteNodeMaterial(),
    process: () => computeNode(),
    start: () => computeNode(),
    ...options,
  });
}

function renderer(dispatched: unknown[], partials = new Float32Array()): IRendererLike {
  const canvas = new EventTarget() as HTMLCanvasElement;
  return {
    compileAsync: async () => undefined,
    compute: (node) => dispatched.push(node),
    dispose: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgpu",
    raw: {},
    render: () => undefined,
    readback: vi.fn(async () => partials.slice().buffer),
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned" as const,
    }),
  };
}

describe("GPUParticles3D", () => {
  it("fails closed for invalid amount, material, and compute callbacks", () => {
    expect(() => particles({ amount: 0 })).toThrow("GPUParticles3D.amount");
    expect(
      () =>
        new GPUParticles3D({
          amount: 1,
          process: () => computeNode(),
          start: () => computeNode(),
        } as never),
    ).toThrow("GPUParticles3D.material");
    expect(() => particles({ start: () => ({}) as never })).toThrow("GPUParticles3D.start");
    expect(() => particles({ process: () => ({}) as never })).toThrow("GPUParticles3D.process");
  });

  it("dispatches start, process, restart, and releases both buffers on removal", () => {
    const dispatched: unknown[] = [];
    const particle = particles();
    const parent = new Group();
    const positionsDispose = vi.spyOn(particle.buffers.positions.value, "dispose");
    const velocitiesDispose = vi.spyOn(particle.buffers.velocities.value, "dispose");
    parent.add(particle);
    const gpu = renderer(dispatched);

    expect(particle.processCadence).toBe("render");
    particle.attachRenderer(gpu);
    expect(dispatched).toHaveLength(1);
    particle.process();
    expect(dispatched).toHaveLength(2);
    particle.emitting = false;
    particle.process();
    expect(dispatched).toHaveLength(2);
    particle.emitting = true;
    particle.restart();
    expect(dispatched).toHaveLength(3);

    parent.remove(particle);
    expect(particle.released).toBe(true);
    expect(positionsDispose).toHaveBeenCalledOnce();
    expect(velocitiesDispose).toHaveBeenCalledOnce();
    particle.process();
    expect(dispatched).toHaveLength(3);
  });
});

describe("GPUParticles3D spawn requests", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A spawn emitter whose dispatches record the ring window the engine uniforms held at dispatch time. */
  function spawner(options: Partial<IGPUParticles3DSpawnOptions> = {}) {
    let request: IGPUParticles3DSpawnRequest | undefined;
    const rings: { first: number; count: number; origin: number[] }[] = [];
    const particle = new GPUParticles3D({
      amount: 4,
      material: new SpriteNodeMaterial(),
      process: () => computeNode(),
      spawn: (_buffers, r) => {
        request = r;
        return computeNode();
      },
      ...options,
    });
    const gpu = renderer([]);
    const compute = vi.fn((node: unknown) => {
      if (node === spawnNode(particle) && request !== undefined)
        rings.push({
          count: request.count.value,
          first: request.first.value,
          origin: (request.origin.value as Vector3).toArray(),
        });
    });
    particle.attachRenderer({ ...gpu, compute });
    return { compute, particle, rings };
  }
  // Warm-up order is [start?, reset, stamp, spawn, process, reduce?]; spawner has no `start`.
  const spawnNode = (p: GPUParticles3D) => p.warmupNodes[2];

  it("gives every call its own slots and wraps onto the oldest", () => {
    const { particle, rings } = spawner();
    particle.emitParticle({ count: 3, origin: { x: 1, y: 2, z: 3 } });
    particle.emitParticle({ count: 1, origin: { x: 4, y: 5, z: 6 } });
    particle.process();
    particle.emitParticle({ count: 3 });
    expect(rings).toEqual([
      { count: 3, first: 0, origin: [1, 2, 3] },
      { count: 1, first: 3, origin: [4, 5, 6] },
      { count: 3, first: 0, origin: [0, 0, 0] },
    ]);
  });

  it("stamps births before the game's spawn kernel runs", () => {
    const { compute, particle } = spawner();
    compute.mockClear();
    particle.emitParticle({ count: 2 });
    expect(compute.mock.calls.map(([node]) => node)).toEqual([
      particle.warmupNodes[1],
      particle.warmupNodes[2],
    ]);
  });

  it("clamps a request over amount, and requests over the frame cap, and counts the excess", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { particle, rings } = spawner();
    particle.emitParticle({ count: 12 });
    particle.emitParticle({ count: 4 });
    particle.emitParticle({ count: 4 });
    expect(rings.map((r) => r.count)).toEqual([4]);
    expect(particle.stats).toEqual({
      clamped: 12 - 4 + 4 + 4,
      recycledLive: undefined,
      spawned: 4,
    });
    expect(warn).toHaveBeenCalledOnce();
    particle.process();
    particle.emitParticle({ count: 2 });
    expect(rings.map((r) => r.count)).toEqual([4, 2]);
  });

  it("honours maxSpawnPerFrame", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { particle, rings } = spawner({ amount: 8, maxSpawnPerFrame: 3 });
    particle.emitParticle({ count: 2 });
    particle.emitParticle({ count: 2 });
    expect(rings.map((r) => r.count)).toEqual([2, 1]);
    expect(particle.stats.clamped).toBe(1);
  });

  it("reports recycledLive only with a lifetime, from the requests still alive", () => {
    const now = vi.spyOn(performance, "now");
    const { particle } = spawner({ lifetime: 1, maxSpawnPerFrame: 100 });
    now.mockReturnValue(0);
    particle.emitParticle({ count: 4 });
    now.mockReturnValue(500);
    particle.emitParticle({ count: 2 });
    expect(particle.stats.recycledLive).toBe(2);
    now.mockReturnValue(2000);
    particle.emitParticle({ count: 2 });
    expect(particle.stats.recycledLive).toBe(2);
  });

  it("rewinds the ring on restart", () => {
    const { particle, rings } = spawner();
    particle.emitParticle({ count: 3 });
    particle.restart();
    particle.emitParticle({ count: 1 });
    expect(rings.map((r) => r.first)).toEqual([0, 0]);
  });

  it("fails closed", () => {
    const { particle } = spawner();
    expect(() => particle.emitParticle({ count: -1 })).toThrow("count");
    expect(() => particle.emitParticle({ count: 1.5 })).toThrow("count");
    expect(() => particle.emitParticle({ origin: { x: Number.NaN, y: 0, z: 0 } })).toThrow(
      "origin.x",
    );
    expect(() => particles().emitParticle()).toThrow("spawn kernel");
    expect(() => particles({ start: undefined })).toThrow("GPUParticles3D.start");
    expect(() => particles({ spawn: 1 as never })).toThrow("GPUParticles3D.spawn");
    expect(() => spawner({ lifetime: 0 })).toThrow("lifetime");
    expect(() => spawner({ maxSpawnPerFrame: 0 })).toThrow("maxSpawnPerFrame");
    const detached = new GPUParticles3D({
      amount: 1,
      material: new SpriteNodeMaterial(),
      process: () => computeNode(),
      spawn: () => computeNode(),
    });
    expect(() => detached.emitParticle()).toThrow("not attached");
  });

  it("keeps an identity world matrix under a moving parent unless localCoords is set", () => {
    const parent = new Group();
    const world = spawner().particle;
    const local = spawner({ localCoords: true }).particle;
    const closed = particles();
    parent.add(world, local, closed);
    parent.position.set(5, 6, 7);
    parent.updateMatrixWorld(true);
    expect(world.matrixWorld.toArray()).toEqual(new Matrix4().toArray());
    expect(local.matrixWorld.elements.slice(12, 15)).toEqual([5, 6, 7]);
    expect(closed.localCoords).toBe(true);
    expect(closed.matrixWorld.elements.slice(12, 15)).toEqual([5, 6, 7]);
  });

  it("passes the engine clock to process, and keeps the one-argument form working", () => {
    const seen: unknown[] = [];
    const clocked = spawner({
      process: (_buffers, runtime) => {
        seen.push(runtime);
        return computeNode();
      },
    });
    expect(clocked.particle.localCoords).toBe(false);
    expect(seen[0]).toMatchObject({ delta: expect.anything(), time: expect.anything() });
  });
});

function partialsOf(cloud: readonly Vector3[]): Float32Array<ArrayBuffer> {
  const data = new Float32Array(256 * 8);
  for (let lane = 0; lane < 256; lane += 1) {
    const lo = new Vector3(1e30, 1e30, 1e30);
    const hi = new Vector3(-1e30, -1e30, -1e30);
    for (let index = lane; index < cloud.length; index += 256) {
      const point = cloud[index];
      if (point === undefined) throw new Error("Missing particle fixture point.");
      lo.min(point);
      hi.max(point);
    }
    lo.toArray(data, lane * 4);
    hi.toArray(data, (lane + 256) * 4);
  }
  return data;
}

const localBounds = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
function camera() {
  return new PerspectiveCamera(60, 1, 0.1, 100);
}

afterEach(() => vi.useRealTimers());

describe("particle bounds and culling", () => {
  it("folds strided lanes into the cloud bounds and ignores empty lanes", () => {
    const cloud = Array.from(
      { length: 600 },
      (_, index) => new Vector3(index - 300, index % 7, -index),
    );
    expect(foldBounds(partialsOf(cloud))).toEqual(new Box3().setFromPoints(cloud));
    expect(foldBounds(partialsOf([]))).toBeUndefined();
    const data = partialsOf([new Vector3(1, 2, 3)]);
    data[1] = Number.NaN;
    expect(foldBounds(data)).toBeUndefined();
    data[1] = 2;
    data[256 * 4 + 2] = Number.POSITIVE_INFINITY;
    expect(foldBounds(data)).toBeUndefined();
    data[256 * 4 + 2] = 3;
    data[3] = Number.NaN;
    expect(foldBounds(data)).toBeUndefined();
    expect(foldBounds(new Float32Array(7))).toBeUndefined();
  });

  it("never culls before a sample lands and gates copies behind the reduction", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const dispatched: unknown[] = [];
    const gpu = renderer(dispatched);
    let land: ((bytes: ArrayBuffer) => void) | undefined;
    gpu.readback = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          land = resolve;
        }),
    );
    const emitter = particles({ boundsEveryFrames: 1 });
    emitter.position.x = 100;
    emitter.attachRenderer(gpu);
    emitter.process(gpu, camera());
    vi.advanceTimersByTime(2000);
    emitter.process(gpu, camera());
    expect(emitter.measuredBounds).toBeUndefined();
    expect(emitter.dispatches).toBe(2);
    expect(emitter.visible).toBe(true);
    expect(gpu.readback).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([
      emitter.warmupNodes[0],
      emitter.warmupNodes[1],
      emitter.warmupNodes[2],
      emitter.warmupNodes[1],
    ]);
    land?.(partialsOf([new Vector3(-1, -1, -1), new Vector3(1, 1, 1)]).buffer);
    await Promise.resolve();
    emitter.process(gpu, camera());
    expect(emitter.measuredBounds).toEqual(localBounds);
    expect(emitter.cull.state).toBe("running");
  });

  it.each([false, true])(
    "restart discards old bounds, including pending=%s samples",
    async (pending) => {
      const outside = partialsOf([new Vector3(100, 0, -5)]);
      const inside = partialsOf([new Vector3(0, 0, -5)]);
      const gpu = renderer([]);
      let land: ((bytes: ArrayBuffer) => void) | undefined;
      gpu.readback = vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            land = resolve;
          }),
      );
      const emitter = particles({ boundsEveryFrames: 1, graceSeconds: 0 });
      const view = camera();
      emitter.attachRenderer(gpu);
      emitter.process(gpu, view);
      if (!pending) {
        land?.(outside.buffer);
        await Promise.resolve();
        emitter.process(gpu, view);
        expect(emitter.cull.reason).toBe("outside-view");
      }
      emitter.restart();
      if (pending) {
        land?.(outside.buffer);
        await Promise.resolve();
      }
      const before = emitter.dispatches;
      emitter.process(gpu, view);
      expect(emitter.measuredBounds).toBeUndefined();
      expect(emitter.cull.state).toBe("running");
      expect(emitter.dispatches).toBe(before + 1);
      land?.(inside.buffer);
      await Promise.resolve();
      emitter.process(gpu, view);
      expect(emitter.measuredBounds).toEqual(new Box3().setFromPoints([new Vector3(0, 0, -5)]));
      expect(emitter.cull.state).toBe("running");
      emitter.detach();
    },
  );

  it.each(["pause", "clear"] as const)(
    "culls a landed sample after grace and resumes with %s",
    async (onCull) => {
      vi.useFakeTimers({ toFake: ["performance"] });
      const dispatched: unknown[] = [];
      const gpu = renderer(dispatched, partialsOf([localBounds.min, localBounds.max]));
      const emitter = particles({ onCull, boundsEveryFrames: 1 });
      const view = camera();
      const buffers = emitter.buffers;
      emitter.position.set(100, 0, -5);
      emitter.attachRenderer(gpu);
      emitter.process(gpu, view);
      await Promise.resolve();
      emitter.process(gpu, view);
      vi.advanceTimersByTime(999);
      emitter.process(gpu, view);
      expect(emitter.dispatches).toBe(3);
      expect(emitter.visible).toBe(true);
      vi.advanceTimersByTime(1);
      const before = dispatched.length;
      emitter.process(gpu, view);
      expect(dispatched).toHaveLength(before);
      expect(emitter.visible).toBe(false);
      expect(emitter.cull).toEqual({
        state: onCull === "pause" ? "paused" : "cleared",
        reason: "outside-view",
        transitions: 1,
      });
      emitter.position.x = 0;
      emitter.process(gpu, view);
      expect(emitter.visible).toBe(true);
      expect(emitter.dispatches).toBe(4);
      expect(emitter.buffers).toBe(buffers);
      expect(dispatched.filter((node) => node === emitter.warmupNodes[0])).toHaveLength(
        onCull === "clear" ? 2 : 1,
      );
      expect(emitter.cull).toEqual({ state: "running", reason: undefined, transitions: 2 });
    },
  );

  it("uses an override from frame zero without measurement, and Infinity disables view culling", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds, graceSeconds: 0 });
    emitter.position.set(100, 0, -5);
    emitter.attachRenderer(gpu);
    emitter.process(gpu, camera());
    expect(emitter.measuredBounds).toBe(localBounds);
    expect(emitter.dispatches).toBe(0);
    expect(emitter.cull.reason).toBe("outside-view");
    expect(gpu.readback).not.toHaveBeenCalled();
    const infinite = particles({ bounds: localBounds, graceSeconds: Number.POSITIVE_INFINITY });
    infinite.position.copy(emitter.position);
    infinite.attachRenderer(gpu);
    infinite.process(gpu, camera());
    vi.advanceTimersByTime(1e6);
    infinite.process(gpu, camera());
    expect(infinite.dispatches).toBe(2);
    expect(infinite.visible).toBe(true);
  });

  it("uses simulated seconds for outside-view grace while wall time stays fixed", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds });
    const view = camera();
    emitter.position.set(100, 0, -5);
    emitter.attachRenderer(gpu);
    const wallTime = performance.now();
    emitter.process(gpu, view, false, undefined, 4);
    emitter.process(gpu, view, false, undefined, 4.99);
    expect(emitter.cull.state).toBe("running");
    emitter.process(gpu, view, false, undefined, 5);
    expect(emitter.cull.reason).toBe("outside-view");
    expect(emitter.dispatches).toBe(2);
    expect(performance.now()).toBe(wallTime);
    emitter.position.x = 0;
    emitter.process(gpu, view, false, undefined, 5);
    expect(emitter.cull.state).toBe("running");
  });

  it("toggles view culling at runtime and starts a fresh grace period on re-enable", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds });
    const view = camera();
    emitter.position.set(100, 0, -5);
    emitter.attachRenderer(gpu);
    emitter.process(gpu, view);
    vi.advanceTimersByTime(1000);
    emitter.process(gpu, view);
    expect(emitter.cull.reason).toBe("outside-view");
    emitter.graceSeconds = Number.POSITIVE_INFINITY;
    emitter.process(gpu, view);
    expect(emitter.visible).toBe(true);
    expect(emitter.dispatches).toBe(2);
    emitter.graceSeconds = 1;
    emitter.process(gpu, view);
    vi.advanceTimersByTime(999);
    emitter.process(gpu, view);
    expect(emitter.cull.state).toBe("running");
    vi.advanceTimersByTime(1);
    emitter.process(gpu, view);
    expect(emitter.cull.reason).toBe("outside-view");
  });

  it.each([-1, Number.NEGATIVE_INFINITY, Number.NaN])(
    "rejects invalid graceSeconds %s in constructor and runtime assignments",
    (value) => {
      expect(() => particles({ graceSeconds: value })).toThrow("GPUParticles3D.graceSeconds");
      const emitter = particles({ graceSeconds: 0 });
      expect(() => {
        emitter.graceSeconds = value;
      }).toThrow("GPUParticles3D.graceSeconds");
      expect(emitter.graceSeconds).toBe(0);
    },
  );

  it("respects emitting, game visibility, and shadow casters", () => {
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds, graceSeconds: 0 });
    emitter.position.set(100, 0, -5);
    emitter.attachRenderer(gpu);
    emitter.emitting = false;
    emitter.process(gpu, camera());
    expect(emitter.dispatches).toBe(0);
    expect(emitter.budget.significance(camera())).toBeUndefined();
    emitter.emitting = true;
    emitter.visible = false;
    emitter.process(gpu, camera());
    emitter.position.x = 0;
    emitter.process(gpu, camera());
    expect(emitter.visible).toBe(false);
    expect(emitter.cull.state).toBe("running");
    emitter.visible = true;
    const shadowCaster: Object3D = emitter;
    shadowCaster.castShadow = true;
    emitter.position.x = 100;
    emitter.process(gpu, camera());
    expect(emitter.visible).toBe(true);
    expect(emitter.cull.state).toBe("running");
  });

  it("transforms the measured box and world padding before testing the view", () => {
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds, graceSeconds: 0, padding: 2 });
    const parent = new Group();
    parent.position.set(100, 0, -5);
    parent.add(emitter);
    emitter.attachRenderer(gpu);
    emitter.process(gpu, camera());
    expect(emitter.cull.reason).toBe("outside-view");
    parent.position.x = 5;
    emitter.process(gpu, camera());
    expect(emitter.visible).toBe(true);
    expect(emitter.cull.state).toBe("running");
  });

  it("preserves a game hide made while view culling already hides the emitter", () => {
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds, graceSeconds: 0 });
    const view = camera();
    emitter.attachRenderer(gpu);
    emitter.position.set(100, 0, -5);
    emitter.process(gpu, view);
    expect(emitter.cull.reason).toBe("outside-view");
    emitter.visible = false;
    emitter.position.x = 0;
    emitter.process(gpu, view);
    expect(emitter.visible).toBe(false);
    emitter.visible = true;
    emitter.process(gpu, view);
    expect(emitter.visible).toBe(true);
  });

  it("keeps hidden and shadow-casting emitters out of the shedding quota", () => {
    const gpu = renderer([]);
    const view = camera();
    const hidden = particles({ bounds: localBounds });
    const shadow = particles({ bounds: localBounds });
    const eligible = particles({ bounds: localBounds });
    hidden.position.z = -100;
    shadow.position.z = -50;
    eligible.position.z = -5;
    hidden.visible = false;
    const caster: Object3D = shadow;
    caster.castShadow = true;
    for (const emitter of [hidden, shadow, eligible]) emitter.attachRenderer(gpu);
    const budget = new ParticleSignificance();
    budget.observe({
      frames: 60,
      presented: { samples: 60, mean: 1000 / 60, p50: 0, p95: 0, p99: 0, max: 0 },
      gpuMs: 16,
      gpuCompute: 1,
      targetFps: 60,
    });
    budget.apply([hidden.budget, shadow.budget, eligible.budget], view, 0);
    for (const emitter of [hidden, shadow, eligible]) emitter.process(gpu, view);
    expect(eligible.cull.reason).toBe("over-budget");
    expect(hidden.budget.significance(view)).toBeUndefined();
    expect(shadow.budget.significance(view)).toBeUndefined();
    expect(hidden.cull.state).toBe("running");
    expect(shadow.cull.state).toBe("running");
  });

  it("yields for budget with buffers intact and ranks unmeasured emitters by distance", () => {
    const gpu = renderer([]);
    const emitter = particles();
    const view = camera();
    emitter.position.z = -5;
    emitter.attachRenderer(gpu);
    const near = emitter.budget.significance(view);
    emitter.position.z = -10;
    expect(emitter.budget.significance(view)).toBeLessThan(near ?? 0);
    emitter.budget.yield(true);
    emitter.process(gpu, view);
    expect(emitter.dispatches).toBe(0);
    expect(emitter.cull.reason).toBe("over-budget");
    emitter.budget.yield(false);
    emitter.process(gpu, view);
    expect(emitter.dispatches).toBe(1);
    expect(emitter.visible).toBe(true);
  });

  it("excludes view-culled emitters from the budget candidates", () => {
    const gpu = renderer([]);
    const emitter = particles({ bounds: localBounds, graceSeconds: 0 });
    emitter.position.x = 100;
    emitter.attachRenderer(gpu);
    emitter.process(gpu, camera());
    expect(emitter.budget.significance(camera())).toBeUndefined();
  });

  it("stops measuring after unsupported readback and releases the reduction", async () => {
    const gpu = renderer([]);
    gpu.readback = vi.fn(async () => {
      throw new Error("unsupported");
    });
    const emitter = particles({ boundsEveryFrames: 1 });
    emitter.attachRenderer(gpu);
    const reduction = emitter.warmupNodes[2];
    if (reduction === undefined) throw new Error("Missing particle reduction node.");
    const dispose = vi.spyOn(reduction, "dispose");
    emitter.process(gpu, camera());
    await Promise.resolve();
    await Promise.resolve();
    emitter.process(gpu, camera());
    expect(gpu.readback).toHaveBeenCalledOnce();
    expect(emitter.dispatches).toBe(2);
    emitter.detach();
    emitter.detach();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("paces measurement and tolerates stubs without readback", async () => {
    const gpu = renderer([]);
    const emitter = particles({ boundsEveryFrames: 3 });
    emitter.attachRenderer(gpu);
    emitter.process(gpu);
    emitter.process(gpu);
    expect(gpu.readback).not.toHaveBeenCalled();
    emitter.process(gpu);
    expect(gpu.readback).toHaveBeenCalledOnce();
    await Promise.resolve();
    emitter.process(gpu);
    emitter.process(gpu);
    expect(gpu.readback).toHaveBeenCalledOnce();
    emitter.process(gpu);
    expect(gpu.readback).toHaveBeenCalledTimes(2);
    const stub = { ...gpu, readback: undefined } as unknown as IRendererLike;
    emitter.process(stub);
    expect(emitter.dispatches).toBe(7);
  });
});
