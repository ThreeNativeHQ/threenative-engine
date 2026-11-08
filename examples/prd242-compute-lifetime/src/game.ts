import { type ICtx, Scene, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Color } from "three";
import { PingPongField } from "./ping-pong-field.js";

interface IComputeLifetimeState extends Record<string, unknown> {
  attachments: number;
  gpuSteps: number;
  passOneDispatches: number;
  passTwoDispatches: number;
  passOrder: number;
  releases: number;
  round: number;
  startupReady: boolean;
  worldRenders: number;
  worldRendersAfterStartup: number;
  warmupNodes: number;
}

const initialState: IComputeLifetimeState = {
  attachments: 0,
  gpuSteps: 0,
  passOneDispatches: 0,
  passTwoDispatches: 0,
  passOrder: 0,
  releases: 0,
  round: 0,
  startupReady: false,
  worldRenders: 0,
  worldRendersAfterStartup: 0,
  warmupNodes: 0,
};

const lifetime = {
  attachments: 0,
  releases: 0,
  round: 0,
};

interface IRenderTransitionState {
  readonly startupReady: boolean;
  readonly worldRenders: number;
  readonly worldRendersAfterStartup: number;
}

function stateFor(
  field: PingPongField,
  renderState: IRenderTransitionState,
): IComputeLifetimeState {
  return {
    attachments: lifetime.attachments,
    gpuSteps: field.steps,
    passOneDispatches: field.passOneDispatches,
    passTwoDispatches: field.passTwoDispatches,
    passOrder: field.passOneDispatches === field.passTwoDispatches && field.steps > 0 ? 1 : 0,
    releases: lifetime.releases,
    round: lifetime.round,
    startupReady: renderState.startupReady,
    worldRenders: renderState.worldRenders,
    worldRendersAfterStartup: renderState.worldRendersAfterStartup,
    warmupNodes: field.warmupNodes.length,
  };
}

abstract class ComputeLifetimeScene extends Scene<IComputeLifetimeState> {
  protected field: PingPongField | undefined;
  startupReady = false;
  worldRenders = 0;
  worldRendersAfterStartup = 0;
  protected abstract readonly nextScene: string | undefined;
  protected abstract readonly transitionRound: number | undefined;

  override enter(ctx: ICtx<IComputeLifetimeState>): void {
    ctx.camera.position.set(0, 0, 4);
    ctx.camera.lookAt(0, 0, 0);
    ctx.scene.background = new Color(0x071526);
    // An opaque layer activates the framework's existing first-use startup window. The compute
    // field's kernels therefore warm before this world is shown, without any game-side await.
    ctx.canvasLayer.opaque = true;
    const field = new PingPongField({
      onRelease: () => {
        lifetime.releases += 1;
      },
    });
    this.field = ctx.add(field) as PingPongField;
    lifetime.attachments += 1;
    ctx.entities.add("compute-field", field);
    ctx.state.set(stateFor(field, this));
    void ctx.startup.whenReady().then(() => {
      this.startupReady = true;
      ctx.canvasLayer.opaque = false;
      ctx.state.set(stateFor(field, this));
    });
  }

  override update(ctx: ICtx<IComputeLifetimeState>): void {
    const field = this.field;
    if (field === undefined) return;
    ctx.state.set(stateFor(field, this));
    if (
      this.nextScene !== undefined &&
      this.transitionRound !== undefined &&
      lifetime.round === this.transitionRound &&
      field.steps >= 4
    ) {
      lifetime.round += 1;
      void ctx.goto(this.nextScene);
    }
  }

  override render(ctx: ICtx<IComputeLifetimeState>): void {
    this.worldRenders += 1;
    if (this.startupReady) this.worldRendersAfterStartup += 1;
    const field = this.field;
    if (field !== undefined) ctx.state.set(stateFor(field, this));
  }
}

class FirstFieldScene extends ComputeLifetimeScene {
  static override readonly initialState = initialState;
  protected readonly nextScene = "second";
  protected readonly transitionRound = 0;
}

class SecondFieldScene extends ComputeLifetimeScene {
  static override readonly initialState = initialState;
  protected readonly nextScene = "first";
  protected readonly transitionRound = 1;
}

const game = defineGame<IComputeLifetimeState>({
  camera: { projection: "perspective", fov: 55 },
  initialState,
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { first: FirstFieldScene, second: SecondFieldScene },
  start: "first",
});

export default game;
