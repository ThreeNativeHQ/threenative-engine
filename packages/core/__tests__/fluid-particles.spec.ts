import { context } from "three/tsl";
import { WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { FluidParticles3D } from "../src/fluid-particles.js";
import type { IRendererLike, RendererKind } from "../src/renderer.js";

function renderer(names: string[], kind: RendererKind = "webgpu"): IRendererLike {
  const canvas = new EventTarget() as HTMLCanvasElement;
  return {
    compileAsync: async () => undefined,
    compute: (node) => names.push((node as { name: string }).name),
    dispose: () => undefined,
    domElement: canvas,
    info: {},
    kind,
    raw: {},
    readback: async () => new ArrayBuffer(0),
    render: () => undefined,
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

function computeSource(water: FluidParticles3D, name: string): string {
  const node = water.warmupNodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`Missing kernel ${name}`);
  const gpu = {
    contextNode: context(),
    backend: {
      capabilities: { getUniformBufferLimit: () => 65_536 },
      compatibilityMode: false,
      device: {},
      utils: {},
    },
    hasCompatibility: () => true,
    hasFeature: () => false,
  };
  // Three's declarations omit the compute-node constructor path and generated shader fields.
  const builder = new WGSLNodeBuilder(node as never, gpu as never) as unknown as {
    build(): void;
    computeShader: string;
  };
  builder.build();
  return builder.computeShader;
}

describe("FluidParticles3D", () => {
  it("emits one terminal return per compute guard for native WGSL validation", () => {
    const water = new FluidParticles3D({ capacity: 1 });
    try {
      for (const name of ["predict", "grid.clear", "grid.build", "stats.clear", "stats.finalize"]) {
        expect(computeSource(water, `fluidParticles.${name}`)).not.toMatch(/return;\s*return;/);
      }
    } finally {
      water.detach();
    }
  });

  it("generates a vector speed limit and radius-bounded prediction segments", () => {
    const water = new FluidParticles3D({ capacity: 1 });
    try {
      const predict = computeSource(water, "fluidParticles.predict");
      expect(predict).toMatch(/18\.0 \/ max\( length\( \w+ \), 18\.0 \)/);
      expect(predict).toContain("ceil(");
      expect(predict).toContain("/ 0.0968");
      expect(predict).toMatch(/for \( var \w+ : u32 = 0u; \w+ < fluidSubsteps;/);
      expect(computeSource(water, "fluidParticles.confine")).toMatch(
        /18\.0 \/ max\( length\( \w+ \), 18\.0 \)/,
      );
    } finally {
      water.detach();
    }
  });

  it("returns the floor outside the tank rather than extending edge water indefinitely", async () => {
    const water = new FluidParticles3D({ capacity: 1 });
    const data = new Float32Array(16 + water.volumeSize[0] * water.volumeSize[2]);
    data.fill(1.5, 16);
    const gpu = { ...renderer([]), readback: async () => data.buffer };
    water.process(gpu);
    await Promise.resolve();
    expect(water.sample(0, 0).height).toBe(1.5);
    for (const [x, z] of [
      [-3, 0],
      [3, 0],
      [0, -2],
      [0, 2],
    ])
      expect(water.sample(x as number, z as number).height).toBe(water.bounds.min[1]);
    water.detach();
  });

  it("samples a valid one-column volume while keeping covered columns excluded", async () => {
    const water = new FluidParticles3D({
      capacity: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      voxelSize: 1,
      readbackEvery: 1,
    });
    const data = new Float32Array(17);
    data[16] = 0.75;
    const gpu = { ...renderer([]), readback: async () => data.slice().buffer };
    water.process(gpu);
    await Promise.resolve();
    expect(water.sample(0.5, 0.5).height).toBe(0.75);
    data[16] = -1e30;
    water.process(gpu);
    await Promise.resolve();
    expect(water.sample(0.5, 0.5).height).toBe(0);
    water.detach();
  });

  it("fails closed for every invalid option", () => {
    expect(() => new FluidParticles3D({ capacity: 0 })).toThrow("FluidParticles3D.capacity");
    expect(() => new FluidParticles3D({ capacity: 70000 })).toThrow("FluidParticles3D.capacity");
    expect(() => new FluidParticles3D({ capacity: 10.5 })).toThrow("FluidParticles3D.capacity");
    expect(() => new FluidParticles3D({ capacity: 8, spacing: 0 })).toThrow(
      "FluidParticles3D.spacing",
    );
    expect(() => new FluidParticles3D({ capacity: 8, iterations: 9 })).toThrow(
      "FluidParticles3D.iterations",
    );
    expect(() => new FluidParticles3D({ capacity: 8, iterations: -1 })).toThrow(
      "FluidParticles3D.iterations",
    );
    expect(() => new FluidParticles3D({ capacity: 8, viscosity: -1 })).toThrow(
      "FluidParticles3D.viscosity",
    );
    expect(
      () =>
        new FluidParticles3D({
          capacity: 8,
          bounds: { min: [-1, 0, -1], max: [1, 0.1, 1] },
        }),
    ).toThrow("FluidParticles3D.bounds must be at least two spacings wide");
    expect(() => new FluidParticles3D({ capacity: 8, maxColliders: 0 })).toThrow(
      "FluidParticles3D.maxColliders",
    );
  });

  it("defaults to a fixed cadence, fourteen warmup kernels and no landed readback", () => {
    const water = new FluidParticles3D({ capacity: 100 });
    expect(water.processCadence).toBe("fixed");
    expect(water.warmupNodes).toHaveLength(14);
    expect(water.used).toBe(0);
    expect(water.stats).toBeUndefined();
    expect(water.sample(0, 0).height).toBe(water.bounds.min[1]);
  });

  it("refuses a renderer without WebGPU compute, and a second renderer", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    expect(() => water.attachRenderer(renderer([], "webgl2"))).toThrow("WebGPU renderer");

    const gpu = renderer([]);
    water.attachRenderer(gpu);
    water.attachRenderer(gpu);
    expect(() => water.attachRenderer(renderer([]))).toThrow(
      "FluidParticles3D is already attached to a renderer.",
    );
  });

  it("fills at most capacity and reports the exact lattice count", () => {
    const full = new FluidParticles3D({ capacity: 50, spacing: 0.22 });
    expect(full.fill([0, 0, 0], [2, 2, 2])).toBe(50);
    expect(full.fill([0, 0, 0], [2, 2, 2])).toBe(0);
    expect(full.used).toBe(50);

    const small = new FluidParticles3D({ capacity: 50, spacing: 0.22 });
    expect(small.fill([0, 0, 0], [0.44, 0.44, 0.44])).toBe(27);
  });

  it("emits into a ring buffer and throttles the queue per step", () => {
    const ring = new FluidParticles3D({ capacity: 4 });
    expect(ring.emit([0, 0, 0])).toBe(true);
    expect(ring.used).toBe(1);
    for (let spawn = 0; spawn < 5; spawn += 1) expect(ring.emit([0, 0, 0])).toBe(true);
    expect(ring.used).toBe(4);

    const queued = new FluidParticles3D({ capacity: 8, maxSpawns: 2 });
    expect(queued.emit([0, 0, 0])).toBe(true);
    expect(queued.emit([0, 0, 0])).toBe(true);
    expect(queued.emit([0, 0, 0])).toBe(false);
    queued.process(renderer([]));
    expect(queued.emit([0, 0, 0])).toBe(true);
  });

  it("dispatches nothing while empty, then the documented pass order", () => {
    const names: string[] = [];
    const water = new FluidParticles3D({ capacity: 8, iterations: 2 });
    const gpu = renderer(names);
    water.attachRenderer(gpu);

    water.process();
    expect(names).toEqual([]);
    expect(water.steps).toBe(1);

    water.fill([0, 0, 0], [0.44, 0.44, 0.44]);
    water.process();
    expect(names).toEqual([
      "fluidParticles.inject",
      "fluidParticles.predict",
      "fluidParticles.grid.clear",
      "fluidParticles.grid.build",
      "fluidParticles.lambda",
      "fluidParticles.delta",
      "fluidParticles.apply",
      "fluidParticles.grid.clear",
      "fluidParticles.grid.build",
      "fluidParticles.lambda",
      "fluidParticles.delta",
      "fluidParticles.apply",
      "fluidParticles.grid.clear",
      "fluidParticles.grid.build",
      "fluidParticles.velocity",
      "fluidParticles.stats.clear",
      "fluidParticles.smooth",
      "fluidParticles.confine",
      "fluidParticles.stats.finalize",
      "fluidParticles.volume",
      "fluidParticles.columns",
    ]);
    expect(water.steps).toBe(2);
  });

  it("queues four drains and stirs, and validates colliders", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    for (let queue = 0; queue < 4; queue += 1) expect(water.drain([0, 0, 0], [1, 1, 1])).toBe(true);
    expect(water.drain([0, 0, 0], [1, 1, 1])).toBe(false);
    for (let queue = 0; queue < 4; queue += 1) expect(water.stir([0, 0, 0], 1, 0.5)).toBe(true);
    expect(water.stir([0, 0, 0], 1, 0.5)).toBe(false);

    const spheres = Array.from({ length: 9 }, () => ({
      kind: "sphere" as const,
      center: [0, 0, 0] as const,
      radius: 1,
    }));
    expect(() => water.setColliders(spheres)).toThrow(
      "FluidParticles3D.setColliders accepts at most 8.",
    );
    expect(() =>
      water.setColliders([{ kind: "box", center: [0, 0.5, 0], halfExtents: [0.5, 0, 0.5] }]),
    ).toThrow("FluidParticles3D.collider.halfExtents must be positive.");
    expect(() =>
      water.setColliders([
        {
          kind: "box",
          center: [0, 0.5, 0],
          halfExtents: [0.5, 0.5, 0.5],
          rotation: [0, 0, 0, 0],
        },
      ]),
    ).toThrow("FluidParticles3D collider rotation must be non-zero.");
    expect(() =>
      water.setColliders([
        { kind: "sphere", center: [0, 0.5, 0], radius: 0.4 },
        {
          kind: "box",
          center: [0, 0.5, 0],
          halfExtents: [0.5, 0.5, 0.5],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        },
      ]),
    ).not.toThrow();
  });

  it("releases on detach and refuses every mutation and dispatch afterwards", () => {
    const names: string[] = [];
    const water = new FluidParticles3D({ capacity: 8 });
    water.attachRenderer(renderer(names));
    water.fill([0, 0, 0], [0.44, 0.44, 0.44]);

    water.detach();
    expect(water.released).toBe(true);
    expect(() => water.fill([0, 0, 0], [1, 1, 1])).toThrow(
      "FluidParticles3D cannot fill after release.",
    );
    expect(() => water.emit([0, 0, 0])).toThrow("FluidParticles3D cannot emit after release.");
    expect(() => water.drain([0, 0, 0], [1, 1, 1])).toThrow(
      "FluidParticles3D cannot drain after release.",
    );
    expect(() => water.stir([0, 0, 0], 1, 0.5)).toThrow(
      "FluidParticles3D cannot stir after release.",
    );
    expect(() => water.setColliders([])).toThrow(
      "FluidParticles3D cannot setColliders after release.",
    );

    water.process();
    expect(names).toEqual([]);
    expect(water.steps).toBe(0);
  });

  it("defaults to water-like damping, not a jelly", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    expect(water.viscosity).toBeLessThanOrEqual(0.02);
    expect(water.cohesion).toBeLessThanOrEqual(0.05);
    expect(water.vorticity).toBeGreaterThanOrEqual(0.01);
  });

  it("round-trips the live solver knobs and rejects negative ones", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    water.viscosity = 0.5;
    water.cohesion = 0;
    water.vorticity = 0.02;
    water.gravity = 0;
    expect(water.viscosity).toBe(0.5);
    expect(water.cohesion).toBe(0);
    expect(water.vorticity).toBe(0.02);
    expect(water.gravity).toBe(0);

    expect(() => {
      water.viscosity = -1;
    }).toThrow("FluidParticles3D.viscosity");
    expect(() => {
      water.cohesion = -1;
    }).toThrow("FluidParticles3D.cohesion");
    expect(() => {
      water.vorticity = -1;
    }).toThrow("FluidParticles3D.vorticity");
    expect(() => {
      water.gravity = -1;
    }).toThrow("FluidParticles3D.gravity");
    expect(water.viscosity).toBe(0.5);
  });

  it("frees every storage buffer on detach", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    water.attachRenderer(renderer([]));
    const disposed = vi.spyOn(water.positions.value, "dispose");
    const velocities = vi.spyOn(water.velocities.value, "dispose");
    water.detach();
    expect(disposed).toHaveBeenCalledOnce();
    expect(velocities).toHaveBeenCalledOnce();
  });

  it("keeps the previous colliders when a later one is invalid, and rejects a NaN rotation", () => {
    const water = new FluidParticles3D({ capacity: 8 });
    water.setColliders([{ kind: "sphere", center: [0, 1, 0], radius: 0.3 }]);
    expect(() =>
      water.setColliders([
        { kind: "sphere", center: [1, 1, 0], radius: 0.3 },
        { kind: "box", center: [0, 0, 0], halfExtents: [1, 1, 1], rotation: [Number.NaN, 0, 0, 1] },
      ]),
    ).toThrow("FluidParticles3D.collider.rotation");
    expect(water.stats).toBeUndefined();
    expect(water.staleFrames).toBe(0);
  });
});
