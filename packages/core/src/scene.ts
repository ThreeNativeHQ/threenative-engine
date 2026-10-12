import type { Camera, Intersection, Object3D, Scene as ThreeScene } from "three";
import type { IAssetLoader } from "./assets.js";
import type { CanvasLayer } from "./canvas-layer.js";
import type { Registry } from "./entities.js";
import type { InputMap } from "./input.js";
import type { AfterPhysicsCallback } from "./loop.js";
import type { IRaycastOptions } from "./picking.js";
import type { IPointerEvents3D } from "./pointer-events.js";
import type { IRandom } from "./random.js";
import type { IRendererLike } from "./renderer.js";
import type { ITweenOptions, ScheduleHandle } from "./schedule.js";
import type { GameStore } from "./state.js";
import type { Viewport } from "./viewport.js";
import type { IWarmUpObservation, WarmUpObservationStatus } from "./warmup.js";

export abstract class Scene<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> {
  static readonly initialState: Record<string, unknown> | undefined = undefined;

  load(_ctx: ICtx<TState, TPhysics>): void | Promise<void> {}

  enter(_ctx: ICtx<TState, TPhysics>): SceneEnterResult<TState, TPhysics> {
    return undefined;
  }

  exit(_ctx: ICtx<TState, TPhysics>): void {}

  update(_ctx: ICtx<TState, TPhysics>, _dt: number): void {}

  render(_ctx: ICtx<TState, TPhysics>): void {}
}

export type SceneConstructor<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> = new () => Scene<TState, TPhysics>;

export type SceneFrame<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> = (ctx: ICtx<TState, TPhysics>, dt: number) => void;

export type SceneEnterResult<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> = // biome-ignore lint/suspicious/noConfusingVoidType: void preserves existing Scene.enter overrides.
void | SceneFrame<TState, TPhysics>;

/**
 * When the framework's startup milestones happened, in milliseconds on the host's monotonic
 * clock (`performance.now()`: since navigation on the web, since process start on native).
 *
 * Absent members have not happened yet. Published to the playtest bridge so a scenario asserts
 * startup time as an observation rather than reading it off a console log.
 */
export interface IStartupTimeline {
  /** The start scene's `load()` began. */
  readonly loadStartedMs?: number;
  /** The start scene's `enter()` returned: the world is built and the loop can move. */
  readonly enteredMs?: number;
  /** First-use compilation settled or its budget expired. */
  readonly compileSettledMs?: number;
  /**
   * The framework's own launch work finished: compilation settled and the frame window held.
   *
   * Equal to `readyMs` unless the game registered a `startup.hold()`. Kept separate so that making
   * `readyMs` honest about the player's wait does not delete the only measurement of the
   * framework's own cost — a game with a slow asset tier would otherwise hide a framework
   * regression inside its own loading time.
   */
  readonly frameworkReadyMs?: number;
  /**
   * `whenReady()` resolved: the world is safe to show, including anything the game held for.
   *
   * This is the number to compare against what a player experiences. It used to be the
   * framework's own readiness and nothing else, which reported 1.5 s on a valley that took 8.8 s
   * to appear — and `assert.startup`'s `maxReadyMs` passed on it.
   */
  readonly readyMs?: number;
}

export interface IStartupStatus {
  /** The most recent warm-up accounting, when a warm-up has run. */
  readonly warmup?: {
    readonly attempted?: number;
    readonly candidates?: number;
    readonly observed?: IWarmUpObservation;
    readonly status: WarmUpObservationStatus;
  };
  /**
   * True once first-use compilation has settled — earlier than `phase === "ready"`, which also
   * waits for a sustained in-budget frame window.
   *
   * This is the signal a game wants when something must not run during the launch. `phase` cannot
   * express it: it is binary, and on a software rasteriser the frame window can only ever expire
   * rather than be met, so a game gated on `phase` alone does nothing for tens of seconds there.
   * Measured as a chase route of length `0.000000` against a required `6`, because the scenario
   * ended before the window did.
   */
  readonly compileSettled: boolean;
  /**
   * `collapsing` until first-use work and a sustained in-budget frame window complete, `ready`
   * once the world is safe to show.
   */
  readonly phase: "observing" | "collapsing" | "ready";
  /**
   * 0 to 1, monotonic and honest: the loader's settled/requested ratio carries the first 0.7
   * while the start scene loads, 0.8 once the world is entered, 0.9 once first-use compilation
   * settled, 1 when `whenReady()` resolves.
   *
   * Monotonic is enforced, not assumed: this is a high-water mark over the measured load state,
   * because that state can fall — requesting an asset after an earlier one settled shrinks the
   * ratio, and a bar that jumps backwards reads to a player as the load restarting.
   */
  readonly progress: number;
  /** When each milestone happened; members appear as they are reached. */
  readonly timeline: IStartupTimeline;
  /** Resolves after first-use work, the sustained frame window, and every game `hold()`. */
  whenReady(): Promise<void>;
  /**
   * Resolves after first-use work and the sustained frame window, and **before** any `hold()`.
   *
   * This is what a game should sequence its own launch work off. `whenReady()` cannot be used for
   * that once the game holds startup: the hold makes readiness wait for the game's work, so work
   * *started* from `whenReady()` waits for a gate that is waiting for it. The cycle is only broken
   * by the hold's budget expiring, which looks exactly like a very slow asset load — measured as a
   * valley revealing its critical tier after a 45 s stall with `trees=1`.
   *
   * Use this when the reason to wait is the framework's launch cost — not competing with first-use
   * compilation, not stealing frames from the stable-frame window — which is the usual reason.
   *
   * @situation start the game's own asset streaming after the framework's launch work, without deadlocking the readiness gate
   */
  whenFrameworkReady(): Promise<void>;
  /**
   * Add the game's own launch work to the readiness gate, so every framework-owned observation of
   * startup describes the moment the player actually reached the world.
   *
   * For a game that streams a second asset tier after the framework is done. Without it the only
   * options are to show a half-built world or to hold a curtain past `whenReady()`, and the second
   * leaves `progress`, `phase`, `timeline.readyMs` and the playtest bridge's `assert.startup` all
   * describing a moment nobody experienced.
   *
   * Fails open twice: a hold that rejects counts as settled, and `budgetMs` bounds how long it may
   * delay the world (45 s by default). A launch slower than it could be is a disappointment; a
   * launch that never finishes because one asset 404'd is a bug.
   *
   * Throws on an empty or duplicate label, and on a hold registered after startup already
   * resolved — each means the caller believes it is gating something it is not.
   *
   * `progress` optionally observes monotonically completed work units (textures, placements or
   * cells), so a fixed display percentage cannot falsely report a stall. Use completed work,
   * never time or frame counts. Regressing/invalid values receive no credit, settlement freezes
   * the count, and the hold's original deadline still applies.
   * `work` may instead be a predicate, polled once per rendered frame until it returns true, for a
   * readiness the game measures rather than awaits (spawn cells loaded). It needs no simulation
   * step, so it also settles under a playtest's deterministic clock, which advances no fixed step
   * while startup is held. A throwing predicate counts as settled.
   *
   * @situation hold the loading screen until the game's own asset tier has landed
   */
  hold(
    label: string,
    work: Promise<unknown> | (() => boolean),
    budgetMs?: number,
    progress?: () => number,
  ): void;
}

export interface ICtx<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> {
  readonly fps: number;
  readonly renderer: IRendererLike;
  readonly viewport: Viewport;
  readonly scene: ThreeScene;
  readonly camera: Camera;
  readonly canvasLayer: CanvasLayer;
  readonly entities: Registry;
  /**
   * Adds a node to the scene and hands it straight back, with its own type intact.
   *
   * Generic rather than `Object3D` because a game writes `const sea = ctx.add(new SpectralOcean())`
   * and then calls a method on it. Erasing the type here makes every typed node in every scene need
   * a cast back to what it already was, and that cast is where a game stops noticing it is holding
   * something else.
   */
  readonly add: <T extends Object3D>(object: T) => T;
  readonly input: InputMap;
  readonly pointer: IPointerEvents3D;
  readonly assets: IAssetLoader;
  readonly after: (delay: number, callback: () => void) => ScheduleHandle;
  /** Register a callback for the engine-owned phase after physics writes solved transforms. */
  readonly afterPhysics: (callback: AfterPhysicsCallback) => () => void;
  /**
   * Register work that runs once per actual world render, after the frame's last fixed update and
   * before the projection reconciles and the renderer draws. A held, loader-only frame has no world
   * draw and therefore dispatches nothing.
   */
  readonly beforeRender: (callback: () => void) => () => void;
  readonly every: (callback: (dt: number) => void) => ScheduleHandle;
  readonly state: GameStore<TState>;
  readonly tween: <T extends object>(
    target: T,
    properties: { [K in keyof T]?: number },
    duration: number,
    options?: ITweenOptions,
  ) => Promise<void>;
  readonly random: IRandom;
  readonly raycast: (options?: IRaycastOptions) => Intersection | undefined;
  readonly raycastAll: (
    options?: IRaycastOptions,
    target?: Intersection[],
  ) => readonly Intersection[];
  /**
   * The framework's own startup work — what a loading screen waits on.
   *
   * A shader may compile the first time something using it is drawn, and the render projection may
   * do its first build in that same frame. Both costs are real and belong before the world is shown.
   *
   * Keeping the world hidden until `whenReady()` resolves does more than hide the mess: the
   * shaders that would have been compiled for geometry the projection then discards are never
   * compiled at all, so waiting is *faster* than not waiting.
   */
  readonly startup: IStartupStatus;
  readonly goto: (name: string) => Promise<void>;
  physics: TPhysics;
}
