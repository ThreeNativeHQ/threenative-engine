import { FluidField2D, type ICtx, Scene, type SceneFrame, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { createFluidView } from "./render/fluid.js";

export interface IFluidFieldState extends Record<string, unknown> {
  queuedSplats: number;
  splats: number;
  steps: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

class FluidScene extends Scene<IFluidFieldState> {
  static override readonly initialState: IFluidFieldState = {
    queuedSplats: 0,
    splats: 0,
    steps: 0,
  };

  override enter(ctx: ICtx<IFluidFieldState>): SceneFrame<IFluidFieldState> {
    const field = new FluidField2D({
      pressureIterations: 8,
      resolution: 128,
      splatRadius: 0.16,
      viscosity: 0,
    });
    ctx.add(field);
    ctx.add(createFluidView(field, ctx.scene, ctx.camera));

    let splats = 0;
    return (frameCtx) => {
      if (frameCtx.input.justPressed("splat")) {
        const pointer = frameCtx.input.raw.pointer.position;
        const size = frameCtx.viewport.size;
        const hasPointer = frameCtx.input.raw.pointer.down || pointer.x !== 0 || pointer.y !== 0;
        const position = hasPointer
          ? { x: clamp01(pointer.x / size.width), y: clamp01(1 - pointer.y / size.height) }
          : { x: 0.5, y: 0.5 };
        field.splat(position, { x: 0.55, y: 0.22 }, 1);
        splats += 1;
      }
      frameCtx.state.set({
        queuedSplats: field.queuedSplats,
        splats,
        steps: field.steps,
      });
      if (frameCtx.input.justPressed("splat")) frameCtx.state.flush();
    };
  }
}

const game = defineGame<IFluidFieldState>({
  step: 1 / 60,
  input: {
    splat: { keys: ["Space"], mouseButtons: [0], pointer: true },
  },
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { fluid: FluidScene },
  start: "fluid",
});

export default game;
