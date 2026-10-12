/**
 * The in-page half of the TSL compute reference (compute-reference.ts serves it): each program is
 * authored in the pinned three's TSL, dispatched by WebGPURenderer, and its storage read back. The
 * native twin (tsl_compute_test.cpp) authors the same program with the native TSL builder.
 *
 * Integer state is integral f32 or wrapping u32 on both sides, so counts compare exactly; positions
 * are f32 arithmetic and compare within rounding.
 */
import * as three from "three";
import {
  Fn,
  If,
  float,
  instanceIndex,
  instancedArray,
  sin,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { FluidParticles3D } from "/core/fluid-particles.js";
import { FluidField2D } from "/core/fluid-field.js";
import { GPUParticles3D } from "/core/particles.js";

export const GRID_COUNT = 10_000;
export const PARTICLE_AMOUNT = 256;
export const PARTICLE_TICKS = 90;
export const PARTICLE_SEED = 1337;

/** u32 LCG, wrapping: the same bits under any WGSL implementation. */
const lcg = (state) => state.mul(uint(1664525)).add(uint(1013904223));
const modulo = (value, n) => value.sub(value.div(uint(n)).mul(uint(n)));

async function read(renderer, attribute) {
  return Array.from(new Float32Array(await renderer.getArrayBufferAsync(attribute)));
}

export const FLUID_RESOLUTION = 16;
export const FLUID_STEPS = 6;

export const programs = {
  async "fluid-particles"(renderer) {
    if (renderer.backend.isWebGPUBackend !== true) throw new Error("fluid reference needs WebGPU");
    const attached = {
      kind: "webgpu",
      compute: (node) => renderer.compute(node),
      readback: (attribute) => renderer.getArrayBufferAsync(attribute),
    };
    const run = async (iterations) => {
      // Only allocation/bounds change; every physical parameter retains the core default.
      const fluid = new FluidParticles3D({ capacity: 12,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, voxelSize: 0.25,
        ...(iterations === undefined ? {} : { iterations }),
      });
      fluid.attachRenderer(attached);
      for (let i = 0; i < 12; ++i) {
        if (!fluid.emit([(i % 3 - 1) * 0.1, (Math.floor(i / 3) % 2 - 0.5) * 0.1,
          (Math.floor(i / 6) - 0.5) * 0.1],
          [0.1 + (i % 3) * 0.07, 0.25, -0.08 + Math.floor(i / 6) * 0.1]))
          throw new Error("fluid reference emission refused");
      }
      for (let tick = 0; tick < 6; ++tick) fluid.process();
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const result = { positions: await read(renderer, fluid.positions.value),
        velocities: await read(renderer, fluid.velocities.value) };
      fluid.detach();
      return result;
    };
    const good = await run();
    const broken = await run(0);
    // The same bound as the native comparison; refuse an insensitive browser oracle.
    if (!good.positions.some((v, i) => Math.abs(v - broken.positions[i]) > 2e-4))
      throw new Error("fluid density red control stayed within the position bound");
    return { ...good, unconstrainedPositions: broken.positions, unconstrainedVelocities: broken.velocities };
  },
  async "fluid-field"(renderer) {
    const field = new FluidField2D({ resolution: FLUID_RESOLUTION, pressureIterations: 5,
      viscosity: 0.03, vorticity: 0.2, splatRadius: 0.24 });
    field.attachRenderer(renderer);
    for (let tick = 0; tick < FLUID_STEPS; tick += 1) {
      if (tick % 2 === 0) {
        field.splat({ x: 0.35, y: 0.45 }, { x: 0.12, y: -0.08 }, 0.7);
        field.splat({ x: 0.72, y: 0.65 }, { x: -0.09, y: 0.11 }, 0.4);
      }
      field.process(renderer);
    }
    // Copy the public samplers, so no test-only access to private ping-pong textures is needed.
    const velocity = instancedArray(FLUID_RESOLUTION ** 2, "vec4");
    const dye = instancedArray(FLUID_RESOLUTION ** 2, "vec4");
    const snapshot = Fn(() => {
      const row = instanceIndex.div(uint(FLUID_RESOLUTION));
      const col = instanceIndex.sub(row.mul(uint(FLUID_RESOLUTION)));
      const uv = vec2(float(col).add(0.5), float(row).add(0.5)).div(FLUID_RESOLUTION);
      velocity.element(instanceIndex).assign(field.velocity.sample(uv));
      dye.element(instanceIndex).assign(field.dye.sample(uv));
    })().compute(FLUID_RESOLUTION ** 2);
    await renderer.computeAsync(snapshot);
    const result = { velocity: await read(renderer, velocity.value), dye: await read(renderer, dye.value) };
    field.detach();
    return result;
  },
  /** PRD-513: one compute pass writes 10,000 instance positions on a 100 x 100 grid with a wave. */
  async "instance-grid"(renderer) {
    const positions = instancedArray(GRID_COUNT, "vec4");
    const time = uniform(0.75);
    const kernel = Fn(() => {
      const row = instanceIndex.div(uint(100));
      const column = float(instanceIndex.sub(row.mul(uint(100))));
      positions
        .element(instanceIndex)
        .assign(vec4(column.mul(0.5), sin(column.mul(0.25).add(time)), float(row).mul(0.5), 1));
    })().compute(GRID_COUNT);
    await renderer.computeAsync(kernel);
    return { positions: await read(renderer, positions.value) };
  },

  /**
   * PRD-527: GPUParticles3D (the real core class) with a game-supplied emitter: each particle lives
   * a seeded number of ticks, then is recycled with a new seed. `state` holds (life, generation).
   */
  async particles(renderer) {
    const state = instancedArray(PARTICLE_AMOUNT, "vec2");
    const seed = (generation) =>
      lcg(lcg(instanceIndex.add(uint(PARTICLE_SEED)).add(generation.mul(uint(7919)))));
    const spawn = (buffers, generation) => {
      const s = seed(generation);
      state.element(instanceIndex).assign(vec2(float(modulo(s, 60).add(uint(1))), float(generation)));
      buffers.positions.element(instanceIndex).assign(vec3(0, 0, 0));
      const x = float(modulo(s.div(uint(64)), 200)).sub(100).mul(0.01);
      const z = float(modulo(s.div(uint(16384)), 200)).sub(100).mul(0.01);
      buffers.velocities.element(instanceIndex).assign(vec3(x, 2, z));
    };
    const particles = new GPUParticles3D({
      amount: PARTICLE_AMOUNT,
      material: new three.SpriteNodeMaterial(),
      start: (buffers) => Fn(() => spawn(buffers, uint(0)))().compute(PARTICLE_AMOUNT),
      process: (buffers) =>
        Fn(() => {
          const current = state.element(instanceIndex);
          const life = current.x.sub(1);
          const generation = current.y;
          const velocity = buffers.velocities.element(instanceIndex);
          buffers.positions
            .element(instanceIndex)
            .assign(buffers.positions.element(instanceIndex).add(velocity.mul(1 / 60)));
          velocity.assign(velocity.sub(vec3(0, 9.8 / 60, 0)));
          state.element(instanceIndex).assign(vec2(life, generation));
          If(life.lessThan(0.5), () => {
            spawn(buffers, uint(generation.add(1)));
          });
        })().compute(PARTICLE_AMOUNT),
    });
    particles.attachRenderer(renderer);
    for (let tick = 0; tick < PARTICLE_TICKS; tick += 1) particles.process(renderer);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    return {
      state: await read(renderer, state.value),
      positions: await read(renderer, particles.buffers.positions.value),
    };
  },
};

/** Runs every program on one renderer and hands the results to the harness. */
export async function runPrograms() {
  const renderer = new three.WebGPURenderer({ antialias: false, forceWebGL: false });
  await renderer.init();
  const info = renderer.backend.adapter?.info ?? {};
  const results = {};
  for (const [name, program] of Object.entries(programs)) results[name] = await program(renderer);
  return {
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "", device: info.device ?? "", description: info.description ?? "" },
    results,
  };
}
