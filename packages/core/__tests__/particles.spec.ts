import { Group, Matrix4, type Vector3 } from "three";
import { Fn } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GPUParticles3D,
  type IGPUParticles3DClosedFormOptions,
  type IGPUParticles3DSpawnOptions,
  type IGPUParticles3DSpawnRequest,
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

function renderer(dispatched: unknown[]): IRendererLike {
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
    readback: async () => new ArrayBuffer(0),
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
  // The spawn node is the last warm-up node before `process`.
  const spawnNode = (p: GPUParticles3D) => p.warmupNodes[p.warmupNodes.length - 2];

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
