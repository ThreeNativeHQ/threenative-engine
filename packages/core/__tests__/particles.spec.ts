import { Box3, Group, type Object3D, PerspectiveCamera, Vector3 } from "three";
import { Fn } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticleSignificance } from "../src/particle-significance.js";
import { GPUParticles3D, foldBounds } from "../src/particles.js";
import type { IRendererLike } from "../src/renderer.js";

function computeNode() {
  return Fn(() => {})().compute(1);
}

function particles(options: Partial<ConstructorParameters<typeof GPUParticles3D>[0]> = {}) {
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
