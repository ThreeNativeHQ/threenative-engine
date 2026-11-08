import type { Scene as ThreeScene } from "three";
import type { AutoBatch } from "./auto-batch.js";
import { ComputeDrivenRegistry } from "./compute-driven.js";
import type { Registry } from "./entities.js";
import type { FrameBudget } from "./frame-budget.js";
import type { IGameConfig, IGamePlatformSource, IGamePluginHooks } from "./game.js";
import type { GeometryCapture } from "./geometry-capture.js";
import type { InputMap } from "./input.js";
import type { PhysicsInterpolation } from "./interpolation.js";
import type { IAfterPhysicsPhase } from "./loop.js";
import type { MatrixWorldPass } from "./matrix-world.js";
import type { ScenePicker } from "./picking.js";
import type { PointerEvents3D } from "./pointer-events.js";
import type { RenderCameraCull } from "./render-camera-cull.js";
import type { SceneRenderProjection } from "./renderProjection.js";
import type { IRendererLike } from "./renderer.js";
import type { ICtx, Scene, SceneFrame } from "./scene.js";
import type { Scheduler } from "./schedule.js";
import type { GameStore } from "./state.js";
import type { IUiBridge } from "./ui-bridge.js";
import type { Viewport } from "./viewport.js";
import type { IWarmUpOptions } from "./warmup.js";

/**
 * The state the boot phases own: every resource a phase acquires, and every flag a phase reads.
 * One object, assigned by name, so a phase that needs a field this lacks fails to compile.
 */
export interface IBootState<TState extends Record<string, unknown>, TPhysics> {
  /** Releases pushed as resources are acquired; `#teardown` drains them, newest first. */
  readonly cleanup: Array<() => void>;
  readonly computeDriven: ComputeDrivenRegistry;
  readonly config: IGameConfig<TState, TPhysics>;
  readonly state: GameStore<TState>;
  /**
   * Unlike afterPhysics, this seam's frame boundary is the world-render block, so it is a plain
   * scene-owned set rather than a phase on the loop.
   */
  readonly beforeRenderCallbacks: Set<() => void>;
  activePlugins: Array<IGamePluginHooks<TState, TPhysics>>;
  aborted: boolean;
  afterPhysicsPhase: IAfterPhysicsPhase | undefined;
  autoBatch: AutoBatch | undefined;
  /** Reused snapshot buffers, one per nesting depth, so a steady frame allocates no callback array. */
  beforeRenderSnapshots: Array<Array<() => void>>;
  beforeRenderDepth: number;
  cameraCull: RenderCameraCull | undefined;
  ctx: ICtx<TState, TPhysics> | undefined;
  entities: Registry | undefined;
  frameBudget: FrameBudget | undefined;
  geometryCapture: GeometryCapture | undefined;
  /**
   * Depth-coupled output needs the scene hook before its pass; ordinary scenes retain the
   * historical after-render hook so an atmosphere-free game has the same render path as HEAD.
   */
  hasDepthCoupledOutput: boolean;
  input: InputMap | undefined;
  interpolation: PhysicsInterpolation | undefined;
  matrixWorld: MatrixWorldPass | undefined;
  /** One-shot notification after the scene that owns the world has entered, before warm-up. */
  onStartSceneEntered: (() => void) | undefined;
  paused: boolean;
  /** The full `goto()` transition, including first-use warm-up, or undefined when none is. */
  pendingSceneEnter: Promise<void> | undefined;
  picker: ScenePicker | undefined;
  pointerEvents: PointerEvents3D | undefined;
  projection: SceneRenderProjection | undefined;
  renderer: IRendererLike | undefined;
  /** Flipped only by a diagnostics consumer announcing itself; see enableRuntimeDiagnostics(). */
  renderMetricsEnabled: boolean;
  resumeScene: string | undefined;
  scene: Scene<TState, TPhysics> | undefined;
  sceneEntered: boolean;
  sceneFrame: SceneFrame<TState, TPhysics> | undefined;
  /** Bumped on every scene change, so a row id is stable exactly as long as the scene is. */
  sceneGeneration: number;
  /**
   * The name of the scene currently entered. Carried across a hot update so a reload resumes
   * where the session was, instead of restoring the game's state into its start scene.
   */
  sceneName: string | undefined;
  scheduler: Scheduler | undefined;
  started: boolean;
  /** Startup readiness has begun its first-use gate; before that, it bakes the entered environment. */
  startupGateStarted: boolean;
  uiBridge: IUiBridge | undefined;
  uiReady: boolean;
  /** The loading cover has lifted and page UI may show state; see `UI_STARTUP_MESSAGE`. */
  uiRevealed: boolean;
  viewport: Viewport | undefined;
}

/** The game's own calls a phase makes, bound to the game. */
export interface IBootHost<TState extends Record<string, unknown>, TPhysics> {
  connectUi(): IUiBridge;
  enterScene(scene: Scene<TState, TPhysics>, ctx: ICtx<TState, TPhysics>): boolean;
  goto(name: string, ctx: ICtx<TState, TPhysics>): Promise<void>;
  postUiStartup(): void;
  teardown(): void;
  warmUpConfiguredExplicitly(): boolean;
  warmUpOptions(): IWarmUpOptions;
}

/**
 * The game's own platform source, else the one a worker host installed on the global scope: worker
 * mode runs the unchanged portable entry, so it cannot pass `platform` here (PRD-752).
 */
export interface IBootPlatform {
  readonly platform: IGamePlatformSource | undefined;
}

export type IBootGame<TState extends Record<string, unknown>, TPhysics> = IBootHost<
  TState,
  TPhysics
> &
  IBootPlatform &
  IBootState<TState, TPhysics>;

/** What the frame loop and the scene-entry phase read from the game, and nothing else. */
export type ILoopPhase<TState extends Record<string, unknown>, TPhysics> = Pick<
  IBootGame<TState, TPhysics>,
  | "aborted"
  | "activePlugins"
  | "beforeRenderCallbacks"
  | "beforeRenderDepth"
  | "beforeRenderSnapshots"
  | "cameraCull"
  | "cleanup"
  | "computeDriven"
  | "config"
  | "enterScene"
  | "entities"
  | "frameBudget"
  | "geometryCapture"
  | "hasDepthCoupledOutput"
  | "input"
  | "matrixWorld"
  | "onStartSceneEntered"
  | "paused"
  | "pendingSceneEnter"
  | "postUiStartup"
  | "projection"
  | "renderer"
  | "renderMetricsEnabled"
  | "scene"
  | "sceneEntered"
  | "sceneFrame"
  | "sceneGeneration"
  | "started"
  | "startupGateStarted"
  | "state"
  | "teardown"
  | "uiBridge"
  | "uiRevealed"
  | "warmUpConfiguredExplicitly"
  | "warmUpOptions"
>;

/** What the startup phase reads and assigns: the loop's view, plus what only the world build touches. */
export type IBootPhase<TState extends Record<string, unknown>, TPhysics> = ILoopPhase<
  TState,
  TPhysics
> &
  Pick<
    IBootGame<TState, TPhysics>,
    | "afterPhysicsPhase"
    | "autoBatch"
    | "connectUi"
    | "ctx"
    | "goto"
    | "interpolation"
    | "picker"
    | "platform"
    | "pointerEvents"
    | "resumeScene"
    | "sceneName"
    | "scheduler"
    | "uiReady"
    | "viewport"
  >;

/** The boot state at rest: nothing acquired, nothing paused, every flag down. */
export function createBootGame<TState extends Record<string, unknown>, TPhysics>(
  input: Pick<IBootState<TState, TPhysics>, "config" | "state"> & IBootHost<TState, TPhysics>,
): IBootGame<TState, TPhysics> {
  const { config } = input;
  return {
    ...input,
    activePlugins: [],
    aborted: false,
    afterPhysicsPhase: undefined,
    autoBatch: undefined,
    beforeRenderCallbacks: new Set(),
    beforeRenderDepth: 0,
    beforeRenderSnapshots: [],
    cameraCull: undefined,
    cleanup: [],
    computeDriven: new ComputeDrivenRegistry(),
    ctx: undefined,
    entities: undefined,
    frameBudget: undefined,
    geometryCapture: undefined,
    hasDepthCoupledOutput: false,
    input: undefined,
    interpolation: undefined,
    matrixWorld: undefined,
    onStartSceneEntered: undefined,
    paused: false,
    pendingSceneEnter: undefined,
    picker: undefined,
    get platform(): IGamePlatformSource | undefined {
      return (
        config.platform ??
        (globalThis as { __tnGamePlatform?: IGamePlatformSource }).__tnGamePlatform
      );
    },
    pointerEvents: undefined,
    projection: undefined,
    renderer: undefined,
    renderMetricsEnabled: false,
    resumeScene: undefined,
    scene: undefined,
    sceneEntered: false,
    sceneFrame: undefined,
    sceneGeneration: 0,
    sceneName: undefined,
    scheduler: undefined,
    started: false,
    startupGateStarted: false,
    uiBridge: undefined,
    uiReady: false,
    uiRevealed: false,
    viewport: undefined,
  };
}

/** Runs every release even after one throws, and returns the failures in the order they came. */
export function runAll(releases: Iterable<() => void>): unknown[] {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** The first failure is the original cause; a release throws that one after all have run. */
export function throwFirst(failures: readonly unknown[]): void {
  if (failures.length > 0) throw failures[0];
}

/**
 * Drains the cleanups, newest first, so a resource is released before anything it was built on.
 * Each release that throws is collected and the rest still run.
 */
export function drainCleanup(cleanup: Array<() => void>): unknown[] {
  return runAll(cleanup.splice(0).reverse());
}

/** Empties the authored scene and everything it was reading from. */
export function clearScene(scene: ThreeScene, computeDriven: ComputeDrivenRegistry): void {
  computeDriven.clear();
  scene.clear();
  scene.background = null;
  scene.environment = null;
  scene.fog = null;
}
