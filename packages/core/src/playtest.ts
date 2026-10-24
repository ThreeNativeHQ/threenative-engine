import {
  type IPlaytestBridgeDescription,
  type IPlaytestBridgeV1,
  type IPlaytestContactObservation,
  type IPlaytestGameplayObservation,
  type IPlaytestObservationSnapshot,
  type IPlaytestSampleRequest,
  type IPlaytestStrideObservation,
  type IPlaytestWorldObservation,
  type JsonPrimitive,
  type JsonValue,
  PLAYTEST_CLOCK_GLOBAL,
  PLAYTEST_PROTOCOL_LIMITS,
  type PlaytestClockMode,
  assertJsonSafe,
  requestedPlaytestClockMode,
} from "@threenative/playtest/protocol";
import { type IThreePlaytestEntity, installThreePlaytestBridge } from "@threenative/playtest/three";
import { Object3D, type Object3D as ThreeObject3D, type Vector2 } from "three";
import type { IAssetLoader } from "./assets.js";
import { audioRuntimeSnapshot } from "./audio.js";
import type { EntitySnapshot } from "./entities.js";
import type { IGameObservationContribution, IGamePluginHooks, IGamePluginRuntime } from "./game.js";
import { GEOMETRY_CAPTURE_CAPABILITY } from "./geometry-capture.js";
import { PIPELINE_CENSUS_CAPABILITY } from "./pipeline-census.js";
import { readRenderChainObservation } from "./render/chain.js";
import type { ICtx } from "./scene.js";
import { CORE_VERSION } from "./version.js";

const currentAgent = typeof navigator === "undefined" ? "node" : navigator.userAgent;

/**
 * Install the playtest bridge into a portable game.
 * @situation expose movement and world observations to a playtest
 * @situation connect a game to the ThreeNative scenario runner
 * @constraint install once in the game's plugin list
 * @example const game = defineGame({ plugins: [playtest()] });
 */
export function playtest<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
>(options: IPlaytestOptions = {}): IGamePluginHooks<TState, TPhysics> {
  let dispose: (() => void) | undefined;
  let attached: Promise<void> | undefined;
  let startSceneEntered: Promise<void> | undefined;
  let disposePipelineCensus: (() => void) | undefined;
  let disposeGeometryCapture: (() => void) | undefined;
  let contactHistory: IPlaytestContactObservation[] = [];
  // The tick a contact happened on, and the tick a published value changed on, are the two
  // halves of "the door opened because the plate was pressed". Both are drained per tick rather
  // than per sample: a sample is a step boundary, and a win arriving 199 ticks into a 200-tick
  // step is indistinguishable at that granularity from one arriving with the contact.
  const watcher = createTransitionWatcher();
  let readTick: (() => number) | undefined;
  return {
    sceneExit: () => {
      contactHistory = [];
      watcher.reset();
    },
    update: (ctx) => {
      const tick = readTick?.();
      if (tick === undefined) return;
      drainContacts(ctx, contactHistory, tick);
      watcher.observe(ctx, tick);
    },
    setup: async (ctx, runtime) => {
      readTick = runtime?.tick;
      const seed = runtime?.seed ?? null;
      // One decision, named once, for both consumers: the freeze below and the bridge's verdict on
      // `advance`. Handing the bridge only a *requested* mode and letting it derive the rest is what
      // let the two disagree — a frozen loop reported as the wall clock publishes a frame rate for a
      // game that was not playing. The deterministic answer is therefore stated rather than derived,
      // and stays `undefined` only when there is no tick producer to be fixed-step about.
      let clockMode: PlaytestClockMode | undefined =
        requestedPlaytestClockMode() ?? (runtime === undefined ? undefined : "fixed-step");
      const wallClock = clockMode === "wall-clock";
      const replayRuntime: IPlaytestWorldObservation["runtime"] =
        runtime?.seed === null || runtime?.seed === undefined
          ? undefined
          : {
              agent: currentAgent,
              core: CORE_VERSION,
              randomState: ctx.random.state,
              rapier: runtime.rapier ?? null,
              step: runtime.step,
            };
      const clockRuntime = runtime as
        | (IGamePluginRuntime & {
            _setClockMode?: (mode: "fixed-step" | "wall-clock") => void;
          })
        | undefined;
      const liveAdvance = runtime === undefined ? undefined : wallClockAdvance(runtime);
      const bridgeOptions: Parameters<typeof installThreePlaytestBridge>[0] = {
        camera: ctx.camera,
        ...(clockMode === undefined ? {} : { clockMode }),
        entities: () => bridgeEntities(ctx),
        components: () => componentObservations(ctx.entities.snapshot()),
        // The live clock has to be driven by the host's own frame pump, so a live run's `advance`
        // waits the span of wall time the count names and reports the ticks that pump ran.
        ...(runtime === undefined
          ? {}
          : {
              fixedStep: async (ticks, options) => {
                // A `goto()` loads asynchronously and a counted batch is synchronous, so ticks
                // spent while it loads simulate no world: a restart is outrun and the run reads
                // a scene that never entered. Counted ticks wait for the scene that owns them.
                await runtime.sceneTransition?.();
                if (clockMode === "wall-clock" && liveAdvance !== undefined)
                  return liveAdvance(ticks);
                let ran = runtime.fixedStep(ticks, options);
                // The batch ends early when a `goto()` began inside it; the rest follows the world.
                while (ran > 0 && ran < ticks) {
                  await runtime.sceneTransition?.();
                  ran += runtime.fixedStep(ticks - ran, options);
                }
                return ran;
              },
              tick: runtime.tick,
            }),
        ...(runtime?.runtimeDiagnosticsSeries === undefined
          ? {}
          : { runtimeDiagnosticsSeries: runtime.runtimeDiagnosticsSeries }),
        // A driven native loop presents nothing between ticks; the render-only operation lets a
        // desktop screenshot draw the standing world without spending a simulation step.
        ...(runtime?.renderCurrent === undefined
          ? {}
          : { renderCurrent: () => runtime.renderCurrent?.() }),
        ...(options.events === undefined ? {} : { events: options.events }),
        gameplay: () => gameplayObservations(ctx, contactHistory, seed, replayRuntime, watcher),
        gameplayChannels: () => gameplayChannels(ctx),
        renderer: ctx.renderer.raw as { getDrawingBufferSize(target: Vector2): Vector2 },
        renderChain: () => {
          const observation = readRenderChainObservation(ctx.renderer);
          return observation === undefined
            ? undefined
            : {
                ...observation,
                contributions: observation.contributions.map((contribution) => ({
                  ...contribution,
                })),
                dropped: observation.dropped.map((stage) => ({ ...stage })),
                requested: [...observation.requested],
                stages: [...observation.stages],
                velocity: { ...observation.velocity },
              };
        },
        resources: stateResources(ctx, runtime),
        scene: ctx.scene,
        // A runner advances ticks far faster than a launch completes, and compute dispatch and
        // the first world present are both held behind an opaque loading layer. Published so the
        // runner waits for the world rather than observing a frozen simulation behind a loader.
        startup: () => ({
          phase: ctx.startup.phase,
          progress: ctx.startup.progress,
          ...(ctx.startup.warmup === undefined ? {} : { warmup: ctx.startup.warmup }),
          ...(runtime?.startupCompileSettled === undefined
            ? {}
            : { compileSettled: runtime.startupCompileSettled() }),
          // Wall-clock milestones, so a scenario asserts startup time as an observation instead
          // of reading it off a console marker after the fact.
          ...(runtime?.startupTimeline === undefined
            ? {}
            : { timeline: runtime.startupTimeline() }),
        }),
      };
      const installation = installThreePlaytestBridge(bridgeOptions);
      let clockDisposed = false;
      const clockControl = {
        _clockEpoch: 0,
        _setClockMode: (mode: unknown) => {
          if (clockDisposed) throw new Error("Playtest clock is disposed.");
          if (mode !== "fixed-step" && mode !== "wall-clock")
            throw new Error("Unknown clock mode.");
          clockRuntime?._setClockMode?.(mode);
          if (mode !== clockMode) clockControl._clockEpoch += 1;
          clockMode = mode;
          bridgeOptions.clockMode = mode;
          return { mode, tick: runtime?.tick(), epoch: clockControl._clockEpoch };
        },
      };
      if (clockRuntime?._setClockMode !== undefined) {
        Object.assign(installation.bridge, { _setClockMode: clockControl._setClockMode });
        Object.defineProperty(installation.bridge, "_clockEpoch", {
          get: () => clockControl._clockEpoch,
        });
      }
      const pipelineCensus = runtime?.pipelineCensus;
      if (runtime !== undefined && pipelineCensus !== undefined) {
        disposePipelineCensus = runtime.observations.contribute({
          capabilities: [PIPELINE_CENSUS_CAPABILITY],
          sample: () => ({ pipelineCensus: pipelineCensus() as unknown as JsonValue }),
        });
      }
      const geometryCapture = runtime?.geometryCapture;
      if (runtime !== undefined && geometryCapture !== undefined) {
        disposeGeometryCapture = runtime.observations.contribute({
          capabilities: [GEOMETRY_CAPTURE_CAPABILITY],
          // Nothing is armed, walked or hooked unless this request asked for a capture: the
          // capability says the runtime can answer, not that every sample pays for one.
          sample: async (request) =>
            request.geometry === undefined
              ? {}
              : { geometry: (await geometryCapture(request.geometry)) as unknown as JsonValue },
        });
      }
      installRuntimeChannels(installation.bridge, runtime);
      // A runner announced itself: it is the one consumer of per-frame render samples, so
      // collection turns on exactly for playtest runs and stays off for every plain `pnpm dev`
      // frame. It reads the same predicate as the boot hold below, because gating collection on
      // the browser's half alone left every device and desktop run with an empty
      // `runtimeDiagnosticsSeries` under an advertised `runtime.performance` — a native host
      // announces itself through `TN_PLAYTEST_ENDPOINT`, not through the expected global.
      if (runnerAnnounced()) {
        runtime?.enableRuntimeDiagnostics?.();
        // Same predicate, same reason, one window later. The hold below covers the boot, and the
        // hold ends the moment the runner attaches -- but the runner then pumps live frames for
        // the rAF warmup and for the whole startup wait before it takes its first observation, and
        // every one of those frames advanced the game on the wall clock. So the simulation time a
        // tick-counting scenario sees before its own first tick was a function of how fast the
        // machine booted. The loop is frozen here instead: from the first frame of the run, ticks
        // are the only clock, which is what the run is already counting.
        //
        // A run that asked for the wall clock is the one consumer that wants the opposite: it
        // measures a frame rate for a game, and the frozen loop's presented frames repeat a
        // standing state while the scenario's ticks arrive in bursts — a profile of a game that is
        // not playing. It asked by name, so it is not frozen.
        if (!wallClock) runtime?.freezeClock?.();
      }
      dispose = installation.dispose;
      attached = holdUntilAttached(
        installation.bridge,
        options,
        () => startSceneEntered,
        runtime?.startSceneLoaded,
      );
      const cleanup = () => {
        if (!clockDisposed && clockRuntime?._setClockMode !== undefined)
          clockControl._setClockMode("fixed-step");
        clockDisposed = true;
        disposePipelineCensus?.();
        disposePipelineCensus = undefined;
        disposeGeometryCapture?.();
        disposeGeometryCapture = undefined;
        dispose?.();
        dispose = undefined;
        attached = undefined;
        startSceneEntered = undefined;
        contactHistory = [];
        readTick = undefined;
        watcher.reset();
      };
      // Hand the hold to the game rather than blocking this plugin's setup. The game waits after
      // load() has registered setup placeholders but before enter() transfers them into live state.
      // describe() releases a no-setup run and waits for the returned scene-enter signal before it
      // reads entity-derived capabilities.
      if (attached !== undefined) {
        const gate = attached.catch((error: unknown) => {
          cleanup();
          throw error;
        });
        if (runtime?.holdStart === undefined) await gate;
        else {
          startSceneEntered = runtime.holdStart(gate);
          // describe() awaits the same promise when called. Attach a rejection handler now so a
          // setup failure cannot become an unhandled rejection when the runner stops at applySetup.
          void startSceneEntered.catch(() => undefined);
        }
      }
      return cleanup;
    },
  };
}

export const PLAYTEST_ATTACH_TIMEOUT_MS = 30_000;

/**
 * Resolves when a runner first calls `describe()`, the handshake every runner performs before
 * it observes anything.
 *
 * Without this, a scenario races the game: a proof that does finite work at startup can finish
 * before the runner takes its first observation, and the assertion then reports
 * TN_PLAYTEST_ASSERTION_TRIVIAL or a zero-delta failure depending only on how fast the device
 * booted. Opt-in, because a game that holds for a runner that never arrives is worse than the
 * race for every non-test caller.
 *
 * Fails closed: if no runner attaches within the timeout, setup throws rather than quietly
 * starting anyway and reproducing the race it was added to remove.
 */
/** The global a playtest runner sets before the page loads, so a game can tell one is coming. */
export const PLAYTEST_RUNNER_EXPECTED_GLOBAL = "__THREENATIVE_PLAYTEST_RUNNER_EXPECTED__";

/**
 * The clock a consumer asks this game to run on, named in the protocol's own vocabulary. Set before
 * the game module evaluates — a production profile does it in the instrumentation it injects ahead
 * of the bundle, on the browser and on native alike, and the browser runner's `--live-clock` does it
 * in an `addInitScript` ahead of every page script.
 *
 * The read and its failure live in the protocol beside the mode they name, so the loop's clock, the
 * bridge's verdict on it and the producer a game installs itself cannot disagree about it.
 */
export { PLAYTEST_CLOCK_GLOBAL };

/**
 * How long a live advance waits for the pump's own tick past the span its ticks name.
 *
 * The room this buys has to be wall time, not a number of fixed slices, because the thing being
 * waited for is a frame and a frame costs what the machine costs: four slices is 33 ms, which is half
 * a frame on the 15 fps host the old bound claimed to cover and a fraction of one on anything
 * slower — and the 2026-10-04 CI host measured 55-59 ms, where those four slices ended at 50.0 ms
 * and read that slow pump as a dead one. Eight slices only bought 83.3 ms, which is still named
 * against a machine the runner was about to measure. The runner counts a wait in ten-tick pieces, so
 * each piece named a 166 ms span and then a few more slices — and Machinefall's map-walk standing
 * scene died on exactly that at load average 142, with the world plainly drawing at 20 fps in the
 * windows either side. A measurement whose subject is a slow machine cannot refuse to measure one.
 *
 * A one-tick request names exactly one frame interval, so a wait that ended on that boundary ran
 * just before the host's next frame and observed nothing: the 2026-09-28 desktop pair failed on
 * that at 58 mean fps. The tick has to come from the pump, and only a pump that has genuinely
 * stopped may end the wait without one.
 */
const WALL_CLOCK_PUMP_TIMEOUT_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The live-clock stand-in for `runtime.fixedStep`: deliver the span of wall time `ticks` fixed steps
 * would cover, and report the ticks the host's own frame pump ran in it.
 *
 * Waiting rather than stepping is the whole point. The loop is not frozen on this path, so the host
 * keeps presenting frames for the whole span and every one of them advances the game at the fixed
 * step's own rate — a run whose simulation rate is the machine's frame rate, which is what a
 * profile is for. It also means the runner needs nothing new: it still asks for tick counts and
 * still batches them, and a burst costs the wall time it always claimed to cost.
 */
function wallClockAdvance(runtime: IGamePluginRuntime): (ticks: number) => Promise<number> {
  const stepMs = runtime.step * 1_000;
  return async (ticks) => {
    const before = runtime.tick();
    await sleep(ticks * stepMs);
    // The span is the floor, not the end: a host whose next frame lands just after it has still
    // presented nothing to report. Keep waiting for the pump's own tick, in half-step slices, and
    // never take one here — the loop is the host's, and a tick invented here would be the profile
    // measuring itself. The deadline is the bound, so a pump that has stopped is a fast failure
    // carrying zero rather than a wait that never ends.
    const deadline = Date.now() + WALL_CLOCK_PUMP_TIMEOUT_MS;
    while (runtime.tick() === before && Date.now() < deadline) await sleep(stepMs / 2);
    return runtime.tick() - before;
  };
}

/**
 * Hold when told to, and by default whenever a browser or native runner announced itself.
 *
 * Without it a scenario races the boot, and how much simulation elapses before the first
 * observation depends on how fast the machine renders — measured on action-rpg's combat
 * scenario, player health 90 on SwiftShader and 95 on a real GPU from the same build. Keyed off
 * the runner rather than off the plugin being installed, because every template installs
 * `playtest()` unconditionally and a game that holds for a runner who never arrives is broken
 * for whoever ran `pnpm dev`. Browser runners set the expected global before navigation; native
 * hosts expose `TN_PLAYTEST_ENDPOINT` when a device/desktop transport is attached.
 */
function shouldHoldUntilAttached(options: IPlaytestOptions): boolean {
  if (options.holdUntilAttached !== undefined) return options.holdUntilAttached;
  return runnerAnnounced();
}

/**
 * Whether a runner announced itself, whichever lane it came from.
 *
 * Browser runners set the expected global before navigation; a native host exposes
 * `TN_PLAYTEST_ENDPOINT` when a device or desktop transport is attached. Both decisions that
 * depend on an announcement — holding the boot, and turning per-frame render collection on — read
 * this one predicate: they were written separately once, and the collection half shipped with only
 * the browser branch, so every device and desktop run answered an advertised
 * `runtime.performance` with an empty series.
 */
function runnerAnnounced(): boolean {
  const host = globalThis as Record<string, unknown>;
  return host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true || host.TN_PLAYTEST_ENDPOINT !== undefined;
}

function holdUntilAttached(
  bridge: IPlaytestBridgeV1,
  options: IPlaytestOptions,
  startSceneEntered: () => Promise<void> | undefined,
  startSceneLoaded?: () => Promise<void>,
): Promise<void> | undefined {
  if (!shouldHoldUntilAttached(options)) return undefined;
  const timeoutMs = options.attachTimeoutMs ?? PLAYTEST_ATTACH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`TN_PLAYTEST_ATTACH_TIMEOUT_INVALID: ${String(options.attachTimeoutMs)}`);
  }
  const describe = bridge.describe;
  const applySetup = bridge.applySetup;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new Error(
          `TN_PLAYTEST_ATTACH_TIMEOUT: no playtest runner applied setup or called describe() within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
    // Node keeps the process alive for a pending timer; a held game must not outlive its host.
    timer.unref?.();
    const release = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    if (applySetup !== undefined) {
      bridge.applySetup = async (request) => {
        try {
          // Setup names entities the start scene's load() registers; an async load is still
          // pending when the runner first attaches.
          await startSceneLoaded?.();
          const confirmation = await applySetup(request);
          release();
          return confirmation;
        } catch (error) {
          fail(error);
          throw error;
        }
      };
    }
    bridge.describe = async () => {
      release();
      await startSceneEntered();
      return describe();
    };
  });
}

export interface IPlaytestOptions {
  readonly events?: () => JsonValue[];
  /**
   * Hold start-scene entry until a runner attaches. Defaults on for an announced runner.
   */
  readonly holdUntilAttached?: boolean;
  /** Milliseconds to wait when `holdUntilAttached` is set. Default {@link PLAYTEST_ATTACH_TIMEOUT_MS}. */
  readonly attachTimeoutMs?: number;
}

function installRuntimeChannels(
  bridge: IPlaytestBridgeV1,
  runtime: IGamePluginRuntime | undefined,
): void {
  const describe = bridge.describe;
  bridge.describe = () =>
    Promise.resolve(describe()).then((description) =>
      addRuntimeCapabilities(description, runtime?.observations.contributions() ?? []),
    );
  const sample = bridge.sample;
  bridge.sample = (request) =>
    Promise.resolve(sample(request)).then((snapshot) =>
      addRuntimeObservations(snapshot, request, runtime?.observations.contributions() ?? []),
    );
}
function addRuntimeCapabilities(
  description: IPlaytestBridgeDescription,
  contributions: readonly IGameObservationContribution[],
): IPlaytestBridgeDescription {
  const capabilities = [...description.capabilities];
  const contributed = contributions.flatMap(({ capabilities }) => capabilities);
  for (const capability of ["runtime.audio", "runtime.world", ...contributed]) {
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return { ...description, capabilities };
}
async function addRuntimeObservations(
  snapshot: IPlaytestObservationSnapshot,
  request: IPlaytestSampleRequest,
  contributions: readonly IGameObservationContribution[],
): Promise<IPlaytestObservationSnapshot> {
  const result: Record<string, unknown> = { ...snapshot };
  for (const contribution of contributions) {
    // Awaited in order: an observation that waits for a presented frame — a geometry capture —
    // cannot be produced inside the request that asked for it, and the collision check below has
    // to see the slices in a stable order.
    const slice = await contribution.sample(request);
    if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
      throw new TypeError("A runtime observation contribution must return a top-level object.");
    }
    assertJsonSafe(slice, "$.runtimeContribution");
    for (const [key, value] of Object.entries(slice)) {
      if (Object.hasOwn(result, key)) {
        throw new Error(
          `TN_PLAYTEST_OBSERVATION_COLLISION: top-level key '${key}' already exists.`,
        );
      }
      result[key] = value;
    }
  }
  // quality-allow: every contributed value is validated as JSON-safe immediately above.
  return result as unknown as IPlaytestObservationSnapshot;
}
function runtimeObservation(
  seed: number | null,
  replayRuntime: IPlaytestWorldObservation["runtime"],
): { audio: ReturnType<typeof audioRuntimeSnapshot>; world: IPlaytestWorldObservation } {
  return {
    audio: audioRuntimeSnapshot(),
    world: {
      seed,
      ...(replayRuntime === undefined ? {} : { runtime: replayRuntime }),
    },
  };
}
function bridgeEntities<TState extends Record<string, unknown>, TPhysics>(
  ctx: ICtx<TState, TPhysics>,
): IThreePlaytestEntity[] {
  return [
    { id: "camera.main", object: ctx.camera },
    ...Object.keys(ctx.entities.snapshot()).flatMap((id) => {
      const object = entityObject(ctx.entities.get(id));
      return object === undefined ? [] : [{ id, object }];
    }),
  ];
}
function entityObject(entity: object | undefined): ThreeObject3D | undefined {
  if (entity instanceof Object3D) return entity;
  // A game's own entity class usually exposes its root as `mesh`, `object` or `group`.
  const roots = entity as { group?: unknown; mesh?: unknown; object?: unknown } | undefined;
  const candidate = roots?.mesh ?? roots?.object ?? roots?.group;
  return candidate instanceof Object3D ? candidate : undefined;
}
function gameplayObservations<TState extends Record<string, unknown>, TPhysics>(
  ctx: ICtx<TState, TPhysics>,
  contactHistory: IPlaytestContactObservation[],
  seed: number | null,
  replayRuntime: IPlaytestWorldObservation["runtime"],
  watcher: ITransitionWatcher,
): IPlaytestGameplayObservation {
  const animation: IPlaytestGameplayObservation["animation"] = {};
  const states: IPlaytestGameplayObservation["states"] = {};
  const snapshot = ctx.entities.snapshot();
  for (const id of Object.keys(snapshot)) {
    const entity = ctx.entities.get(id) as
      | {
          animation?: {
            advancedFrames?: unknown;
            current?: unknown;
            finished?: unknown;
            stride?: unknown;
          };
          state?: unknown;
        }
      | undefined;
    const finished =
      typeof entity?.animation?.finished === "boolean" ? entity.animation.finished : undefined;
    if (
      typeof entity?.animation?.current === "string" &&
      typeof entity.animation.advancedFrames === "number"
    ) {
      const stride = strideObservation(entity.animation.stride);
      animation[id] = {
        advancedFrames: entity.animation.advancedFrames,
        clip: entity.animation.current,
        ...(finished === undefined ? {} : { finished }),
        ...(stride === undefined ? {} : { stride }),
      };
    }
    if (typeof entity?.state === "string") states[id] = entity.state;
  }
  const channels = gameplayChannels(ctx);
  // The per-tick update hook has already drained everything that happened since the last sample
  // and stamped each event with its tick. This final drain catches a run whose bridge is sampled
  // without the loop having ticked — a paused game, a wall-clock scenario — and stamps those with
  // the tick the loop last reported. Contacts are never dropped for want of a tick.
  const contacts = channels.includes("runtime.contacts")
    ? drainContacts(ctx, contactHistory, watcher.lastTick())
    : undefined;
  const tags = channels.includes("runtime.tags") ? tagCounts(snapshot) : undefined;
  const transitions = watcher.read();
  return {
    animation,
    ...(contacts === undefined ? {} : { contacts }),
    states,
    ...(tags === undefined ? {} : { tags }),
    ...(transitions === undefined ? {} : { transitions }),
    ...runtimeObservation(seed, replayRuntime),
  };
}
/**
 * Read an animation player's stride report, or report nothing.
 *
 * A partially shaped report is dropped whole rather than filled in: a stride number the producer
 * did not measure would be read downstream as a measurement, and the one thing this harness may
 * never do is hand back an unmeasured zero. `strideSync: false` still reports — that is the
 * override being honest about what it turned off.
 */
function strideObservation(value: unknown): IPlaytestStrideObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const report = value as Record<string, unknown>;
  const numbers = ["clipGroundSpeed", "groundSpeed", "rate"] as const;
  const flags = ["overridden", "synced"] as const;
  if (!numbers.every((key) => typeof report[key] === "number" && Number.isFinite(report[key])))
    return undefined;
  if (!flags.every((key) => typeof report[key] === "boolean")) return undefined;
  return {
    clipGroundSpeed: report.clipGroundSpeed as number,
    groundSpeed: report.groundSpeed as number,
    ...(typeof report.inPlace === "boolean" ? { inPlace: report.inPlace } : {}),
    overridden: report.overridden as boolean,
    rate: report.rate as number,
    synced: report.synced as boolean,
  };
}

type GameplayChannel = "runtime.contacts" | "runtime.tags" | "runtime.transitions";
interface IContactEvent {
  /** The area that observed the contact, when the source reports one. */
  readonly area?: object;
  readonly body: object;
  readonly entity?: string;
  readonly started: boolean;
}
interface IContactSource {
  drainContacts(): readonly IContactEvent[];
}

function gameplayChannels<TState extends Record<string, unknown>, TPhysics>(
  _ctx: ICtx<TState, TPhysics>,
): GameplayChannel[] {
  return ["runtime.contacts", "runtime.tags", "runtime.transitions"];
}
function drainContacts<TState extends Record<string, unknown>, TPhysics>(
  ctx: ICtx<TState, TPhysics>,
  history: IPlaytestContactObservation[],
  tick: number | undefined,
): IPlaytestContactObservation[] {
  // Build the value→id index without extracting debug fields. First id wins per value, matching
  // the insertion-order find it replaced.
  const idsByEntity = new Map<object, string>();
  ctx.entities.forEach((id, registered) => {
    for (const value of objectGraphValues(registered))
      if (!idsByEntity.has(value)) idsByEntity.set(value, id);
  });
  ctx.entities.forEach((_id, registered) => {
    for (const source of entitySources(registered)) {
      for (const event of source.drainContacts()) {
        const entity = idsByEntity.get(event.body);
        // The area's own `entity` option names the far side of the contact. A game that
        // registered the area under a scene-registry id has already named it, and requiring the
        // option again meant a demonstrably firing trigger reported no contact at all — a green
        // `contacts` assertion over a run whose own state proved the overlap happened.
        const other =
          event.entity ??
          (event.area === undefined ? undefined : idsByEntity.get(event.area)) ??
          idsByEntity.get(source);
        if (entity === undefined || other === undefined) continue;
        history.push({
          entity,
          kind: event.started ? "trigger" : "trigger.exit",
          ...(tick === undefined ? {} : { tick }),
          with: other,
        });
        if (history.length > PLAYTEST_PROTOCOL_LIMITS.maxEventsPerDrain) history.shift();
      }
    }
  });
  return [...history];
}
/**
 * When a published value changed, and to what — the other half of "because".
 *
 * A run has always been able to say *a contact happened* and *the state reads `won`*. Nothing
 * related the two, and a scenario could only compare at step boundaries, where a win arriving one
 * tick after the contact and a win arriving 199 ticks later inside the same step are the same
 * observation. That is exactly the shape of a game whose terminal state comes from a timer or a
 * distance check and merely happens to land near a contact.
 *
 * The watcher diffs the published surface once per tick and records every change with the tick it
 * happened on. It watches what a scenario can name: each registered entity's `state`, and the
 * top-level primitive fields of the game's own published state. A deeper path is not watched, and
 * an assertion about one fails closed rather than being answered from a value nobody diffed.
 */
export const PLAYTEST_TRANSITION_LOG_LIMIT = 512;

export interface IPlaytestTransition {
  from: JsonPrimitive;
  /** `states.<entity>` for a registered entity, or `state.<field>` for a published field. */
  path: string;
  tick: number;
  to: JsonPrimitive;
}

interface ITransitionWatcher {
  lastTick(): number | undefined;
  observe<TState extends Record<string, unknown>, TPhysics>(
    ctx: ICtx<TState, TPhysics>,
    tick: number,
  ): void;
  read(): IPlaytestTransition[] | undefined;
  reset(): void;
}

function primitiveOrUndefined(value: unknown): JsonPrimitive | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createTransitionWatcher(): ITransitionWatcher {
  let previous = new Map<string, JsonPrimitive>();
  let log: IPlaytestTransition[] = [];
  let seen = false;
  let tickSeen: number | undefined;
  const record = (path: string, to: JsonPrimitive, tick: number): void => {
    const had = previous.has(path);
    const from = previous.get(path);
    previous.set(path, to);
    // The first value a path ever reports is its initial value, not a transition. Recording it as
    // one would make every scenario's `neverBefore` fail against the game's own starting state.
    if (!had || from === to) return;
    log.push({ from: from as JsonPrimitive, path, tick, to });
    if (log.length > PLAYTEST_TRANSITION_LOG_LIMIT) log.shift();
  };
  return {
    lastTick: () => tickSeen,
    observe: (ctx, tick) => {
      tickSeen = tick;
      seen = true;
      ctx.entities.forEach((id, entity) => {
        const candidate = entity as { state?: unknown };
        if (typeof candidate.state === "string") record(`states.${id}`, candidate.state, tick);
      });
      // The store is read without flushing: a flush is a publish to the UI, and an observer must
      // not change when the game's own subscribers run.
      const state = ctx.state.getState() as Record<string, unknown>;
      for (const key of Object.keys(state)) {
        const value = primitiveOrUndefined(state[key]);
        if (value !== undefined) record(`state.${key}`, value, tick);
      }
    },
    // Absent until the loop has ticked at least once. A run that never ticked has not observed
    // that nothing changed; it has observed nothing, and an assertion against it must say so.
    read: () => (seen ? log.map((entry) => ({ ...entry })) : undefined),
    reset: () => {
      previous = new Map();
      log = [];
      seen = false;
      tickSeen = undefined;
    },
  };
}

function entitySources(entity: object | undefined): IContactSource[] {
  return objectGraphValues(entity).filter(
    (value): value is IContactSource =>
      "drainContacts" in value &&
      typeof (value as { drainContacts?: unknown }).drainContacts === "function",
  );
}

/** Walk registered fields far enough to reach the physics adapter without traversing Three's graph. */
function objectGraphValues(root: object | undefined): object[] {
  if (root === undefined) return [];
  const values: object[] = [];
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    values.push(value);
    if (depth >= 4 || value instanceof Object3D) return;
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(root, 0);
  return values;
}

function tagCounts(snapshot: EntitySnapshot): Record<string, { count: number }> {
  const counts: Record<string, { count: number }> = {};
  for (const fields of Object.values(snapshot)) {
    for (const tag of fields.tags ?? []) counts[tag] = { count: (counts[tag]?.count ?? 0) + 1 };
  }
  return counts;
}

function componentObservations(
  snapshot: EntitySnapshot,
): Record<string, Record<string, JsonValue>> {
  const components: Record<string, Record<string, JsonValue>> = {};
  for (const [id, fields] of Object.entries(snapshot)) {
    if (Object.keys(fields).length === 0) continue;
    assertJsonSafe(fields, `$.components.${id}`);
    components[id] = fields as Record<string, JsonValue>;
  }
  return components;
}

function stateResources<TState extends Record<string, unknown>, TPhysics>(
  ctx: ICtx<TState, TPhysics>,
  runtime: IGamePluginRuntime | undefined,
) {
  return {
    read: () => {
      ctx.state.flush();
      const state = ctx.state.getState();
      assertJsonSafe(state);
      // A bridge sample is an observation, not a live view. The store's current object is
      // mutated in place by later patches and scene resets; returning it directly makes an
      // earlier `before` sample change when a menu navigates to the next scene.
      const value = cloneJsonValue(state) as Record<string, JsonValue>;
      return Object.fromEntries([
        // `state` is canonical. Keep `GameState` as a compatibility alias until published
        // scenarios have migrated, then remove the alias in a future breaking release.
        ["state", value],
        ["GameState", value],
        // Where every asset was actually served from, on every target and not only in a browser
        // console log: a game whose manifest never loaded runs on the uncompiled source directory
        // and looks healthy, and without this nothing observable says so.
        ["assets", assetResolutions(ctx.assets)],
        ...(runtime?.frameCounts === undefined
          ? []
          : [["__threenativeFrameCounts", runtime.frameCounts()]]),
      ]);
    },
  };
}

/**
 * The asset loader's `resolved` ledger, nested on the dots of each logical path.
 *
 * An observation path addresses a value with dots, so a logical path — which is itself dotted —
 * cannot be a key here without being split first. Nesting keeps it lossless and makes
 * `path: "native-proof.png.via"` read as what it is.
 */
function assetResolutions(assets: IAssetLoader): Record<string, JsonValue> {
  const nested: Record<string, JsonValue> = {};
  for (const [logical, record] of assets.resolved) {
    const parts = logical.split(".");
    let node = nested;
    for (const part of parts.slice(0, -1)) {
      const child = (node[part] ?? {}) as Record<string, JsonValue>;
      node[part] = child;
      node = child;
    }
    node[parts.at(-1) ?? logical] = { url: record.url, via: record.via };
  }
  return nested;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return value;
}
