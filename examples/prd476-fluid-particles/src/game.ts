import { FluidParticles3D, type ICtx, Scene, type SceneFrame, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { CouplingScene } from "./coupling.js";
import { createPointsView } from "./render/points.js";
import { type IFluidParticlesState, INITIAL_STATE } from "./state.js";

/** The dam gate comes out after this many fixed steps (0.8 s, as in the lab). */
const GATE_STEPS = 48;
const GATE = { kind: "box", center: [-0.9, 2.4, 0], halfExtents: [0.05, 2.4, 1.6] } as const;

class DamBreakScene extends Scene<IFluidParticlesState, IPhysicsContext> {
  static override readonly initialState: IFluidParticlesState = INITIAL_STATE;

  override enter(
    ctx: ICtx<IFluidParticlesState, IPhysicsContext>,
  ): SceneFrame<IFluidParticlesState, IPhysicsContext> {
    const query = new URLSearchParams(globalThis.location?.search ?? "");
    const knob = (name: string): number | undefined =>
      query.has(name) ? Number(query.get(name)) : undefined;
    const water = new FluidParticles3D({
      capacity: 6000,
      viscosity: knob("visc"),
      cohesion: knob("coh"),
      iterations: knob("iter"),
      vorticity: knob("vort"),
    });
    ctx.add(water);
    ctx.add(createPointsView(water, ctx.scene, ctx.camera));
    // ?stress=1 fills the whole tank to capacity (6,000 particles) and keeps no gate.
    const stress = new URLSearchParams(globalThis.location?.search ?? "").has("stress");
    if (stress) water.fill([-2.8, 0.1, -1.5], [2.8, 3.6, 1.5]);
    else {
      water.setColliders([GATE]);
      water.fill([-2.8, 0.1, -1.5], [-1.0, 2.8, 1.5]);
    }

    if (new URLSearchParams(globalThis.location?.search ?? "").has("bench")) {
      // Back-to-back solver steps timed to GPU completion: the cost of one fixed step, with no
      // presentation in the number.
      const device = (
        ctx.renderer.raw as {
          backend?: { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } };
        }
      ).backend?.device;
      (globalThis as Record<string, unknown>).__fluidBench = async (steps: number) => {
        await device?.queue.onSubmittedWorkDone();
        const start = performance.now();
        for (let step = 0; step < steps; step += 1) water.process(ctx.renderer);
        await device?.queue.onSubmittedWorkDone();
        return (performance.now() - start) / steps;
      };
      // GPU-side cost per step from timestamp queries (browser `allow_unsafe_apis` dawn feature);
      // the pool holds 2,048 queries at two per pass, so keep `steps` under ~40.
      const raw = ctx.renderer.raw as {
        backend?: { trackTimestamp?: boolean };
        info?: { compute?: { timestamp?: number } };
        resolveTimestampsAsync?: (type: string) => Promise<number>;
      };
      (globalThis as Record<string, unknown>).__fluidGpuMs = async (steps: number) => {
        if (raw.backend === undefined || raw.resolveTimestampsAsync === undefined) return -1;
        raw.backend.trackTimestamp = true;
        for (let step = 0; step < steps; step += 1) water.process(ctx.renderer);
        await device?.queue.onSubmittedWorkDone();
        await raw.resolveTimestampsAsync("compute");
        raw.backend.trackTimestamp = false;
        return (raw.info?.compute?.timestamp ?? -1) / steps;
      };
    }
    (globalThis as Record<string, unknown>).__fluidProbe = () => ({
      steps: water.steps,
      stats: water.stats,
    });
    let peakFrontX = 0;
    return (frame) => {
      if (water.steps === GATE_STEPS) water.setColliders([]);
      const stats = water.stats;
      const { min, max } = water.bounds;
      const slack = 0.01;
      peakFrontX = Math.max(peakFrontX, stats?.max[0] ?? 0);
      frame.state.set({
        count: stats?.count ?? 0,
        steps: water.steps,
        meanCompression: stats?.meanCompression ?? 1,
        maxSpeed: stats?.maxSpeed ?? 99,
        frontX: stats?.max[0] ?? 0,
        peakFrontX,
        minY: stats?.min[1] ?? 0,
        maxY: stats?.max[1] ?? 0,
        inBounds:
          stats !== undefined &&
          [0, 1, 2].every(
            (axis) =>
              (stats.min[axis] as number) >= (min[axis] as number) - slack &&
              (stats.max[axis] as number) <= (max[axis] as number) + slack,
          )
            ? 1
            : 0,
        released: water.steps > GATE_STEPS ? 1 : 0,
        staleFrames: stats?.staleFrames ?? 0,
      });
    };
  }
}

const game = defineGame<IFluidParticlesState, IPhysicsContext>({
  step: 1 / 60,
  plugins: [rapier({ gravity: { x: 0, y: -9.81, z: 0 } }), playtest()],
  render: { preferWebGPU: true },
  scenes: { coupling: CouplingScene, dam: DamBreakScene },
  start:
    new URLSearchParams(globalThis.location?.search ?? "").get("scene") === "coupling"
      ? "coupling"
      : "dam",
});

export default game;
