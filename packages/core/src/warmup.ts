import type { Camera, Object3D, Texture } from "three";
import { pmremTexture } from "three/tsl";

import { isAutoBatchSource } from "./auto-batch.js";
import type { IPipelineCensus } from "./pipeline-census.js";
import { STARTUP_HOLD_BUDGET_MS } from "./startup-readiness.js";

/**
 * Compiles a scene's pipelines before the first frame, in slices, yielding between them.
 *
 * On a phone every distinct pipeline is built the first time something using it is drawn. Nothing
 * spreads that cost: the first `render()` of a fully built scene compiles all of it, on the main
 * loop, inside one frame. Measured on a Pixel 8, `sandbox/fps-framework` spent **24.5 seconds
 * across 107 pipeline compiles** inside a single frame — 92 % of everything the launch-stall
 * budget could attribute (`TN_STALL_SEGMENTS`, PRD-218). For that whole span the loop presented
 * nothing, drained no UI messages and ran no callback, so the loading screen froze mid-animation
 * and the game read as hung. The player's report was "the loading screen takes thirty seconds".
 *
 * This does not make the compiling cheaper — the same pipelines are built either way, and a claim
 * otherwise would be a lie the next measurement catches. What it changes is **who waits and
 * whether anything moves**: the work is cut into slices with a frame between them, so the loop
 * presents, the loading screen animates, the UI bridge delivers, and progress is a number the game
 * can show instead of a static label. A cost that cannot be removed must at least be visible; that
 * is the whole of what this buys, and it is worth saying plainly.
 *
 * The slices are compiled through the renderer's own `compileAsync`, which is stock `three`.
 * Nothing here mutates the scene: no reparenting, no temporary groups, no visibility flipping. A
 * warm-up that edited the graph to compile it would be a correctness risk taken for a progress
 * bar, and the object it handed back would not be the one the game authored.
 */

/** One renderable's worth of progress, reported as the warm-up advances. */
export interface IWarmUpProgress {
  /** Renderable candidates handed to the renderer so far. */
  readonly done: number;
  /** Renderable candidates the warm-up will hand to the renderer in total. */
  readonly total: number;
}

/** The result of the optional persistent warm-up hint. */
export type WarmUpCacheStatus = "disabled" | "unavailable" | "miss" | "hit" | "stored";

export interface IWarmUpCacheOptions {
  /**
   * A game-owned revision for the scene's materials, shaders and renderer settings.
   *
   * The value is a hint that the native driver's own pipeline cache survived a relaunch; it is
   * not a serialized WebGPU pipeline. Change it whenever those inputs change. A missing or
   * unavailable localStorage implementation never prevents the warm-up from running.
   */
  readonly key: string;
}

export interface IWarmUpOptions {
  /** Compute kernels to compile in the same bounded startup window as draw pipelines. */
  readonly computeNodes?: readonly unknown[];
  /**
   * Renderable candidates handed to the renderer between yields. Default 24.
   *
   * The trade is presented frames against total warm-up time: every yield costs one frame's
   * present, and a slice of one would spend more time presenting than compiling. 24 puts a frame
   * on the screen roughly every 30 objects' worth of work while adding a handful of presents to
   * the launch.
   */
  readonly sliceSize?: number;
  /** Called after each slice. Never called with `done` greater than `total`. */
  readonly onProgress?: (progress: IWarmUpProgress) => void;
  /**
   * How the warm-up lets the host present between slices. Defaults to yielding one macrotask,
   * which is one native-runtime loop iteration and therefore one presented frame. A caller that
   * knows its host wants a different signal passes one; a test passes a resolved promise.
   */
  readonly yieldFrame?: () => Promise<void>;
  /**
   * How long one pipeline may take before the warm-up gives up on it. Default 2000 ms.
   *
   * A real compile on a Pixel 8 measured ~77 ms; two seconds is a compile that is not coming back.
   */
  readonly compileTimeoutMs?: number;
  /**
   * How long the whole warm-up may take before it stops and lets the game start. Default 15000 ms.
   *
   * The launch must never be *worse* for having tried to optimize it.
   *
   * It bounds compilation only, and starts once the scene's environment is prepared: a
   * full-quality PMREM bake is lighting the first frame needs, not compile work, and on a software
   * adapter it alone outlasts this budget (about 20 s on 3-CPU SwiftShader).
   */
  readonly budgetMs?: number;
  /**
   * How long the scene environment's PMREM preparation may take before warm-up gives up on it and
   * compiles anyway. Default `STARTUP_HOLD_BUDGET_MS` (45000 ms), the startup bound for a game's own
   * launch work.
   */
  readonly environmentBudgetMs?: number;
  /**
   * How the scene is handed to the renderer. Default `"scene"`.
   *
   * `"scene"` makes one `compileAsync(scene, camera)` call, which is the shape `three` is built
   * for and the only one measured to be affordable: on a Pixel 8 the renderer builds all 107 of
   * this game's pipelines in **8.1 s** that way.
   *
   * `"object"` walks every renderable candidate and yields between slices, which is the only way
   * to show candidate progress. The renderer owns cache reuse and actual pipeline identity, so the
   * warm-up never drops an object based on a material or geometry guess.
   */
  readonly granularity?: "scene" | "object";
  /**
   * Remember a completed warm-up so a later launch can trust the driver's persistent cache.
   * This is opt-in because WebGPU does not expose a portable pipeline-serialization API.
   */
  readonly cache?: IWarmUpCacheOptions;
  /**
   * Render the warm scene once after compiling, so every pass's pipelines exist before the first
   * frame. Default `true`.
   *
   * `compileAsync` builds only the main-pass pipelines. A shadow-casting light's shadow map and a
   * reflection pass each need their own variants, created synchronously on first use — on a native
   * Midway launch that was **44–107 pipelines after "ready"**, with freezes up to 615 ms. One
   * hidden render of the warm scene, with the shadow map forced to update, builds them while the
   * startup cover is still up. The render is invisible (it does not clear, and its output is
   * behind the loading layer) and restores every renderer and scene state it touches.
   *
   * Set `false` to skip it. The warm-up still reports `passes: []` and `passPipelines: 0`, because
   * turning a convention off must not turn its measurement off.
   */
  readonly renderPasses?: boolean;
  /**
   * Runs right after every draw the warm-up makes outside the game's frame loop, so the loading
   * cover can be painted over it.
   *
   * Such a draw runs in a timer task, and the browser presents it on its own: a Wasm engine that is
   * still baking the environment presents black, and the cover flickers against it for the whole
   * bake. Painting the cover in the same task makes the presented frame the cover again. Leave it
   * unset when nothing covers the canvas.
   */
  readonly afterCoveredDraw?: () => void;
  /**
   * Also render objects the scene has hidden for that one covered render. Default `false`.
   *
   * `renderPasses` already disables frustum culling, so every caster is submitted to the shadow
   * pass and every reflected object to the reflection pass even when the startup camera cannot see
   * it. A hidden LOD level or a parked model is still skipped, though: three never draws a subtree
   * whose ancestor's `visible` is false, so its shadow and reflection pipelines stay unbuilt. With
   * this on, the warm-up forces every hidden object visible for that one render — ancestors
   * included — and restores every original `visible` exactly afterwards. The count is reported as
   * `visibilityForced`, so a game can see how much of its scene the render had to un-hide.
   */
  readonly includeHidden?: boolean;
  /** The scene that supplies lights and environment when `scene` is an unattached object. */
  readonly targetScene?: Object3D;
}

/** What the warm-up did, so a caller can report it rather than assume it. */
export type WarmUpObservationStatus = "complete" | "incomplete" | "unavailable";

export interface IWarmUpObservation {
  /** Pipeline creations observed between the census snapshots. */
  readonly created: number;
  /** Pipeline creations that failed between the census snapshots. */
  readonly failed: number;
  /** Pipeline creations still pending at the ending census snapshot, delta-adjusted. */
  readonly pending: number;
  /** New shader-program identities observed between the census snapshots. */
  readonly uniquePrograms: number;
  /** New backend pipeline identities observed between the census snapshots. */
  readonly uniquePipelines: number;
  /** Whether the renderer supplied a complete observation for this warm-up. */
  readonly status: WarmUpObservationStatus;
}

export interface IWarmUpReport {
  /** Compile calls that settled successfully; retained for compatibility with existing callers. */
  readonly compiled: number;
  /**
   * @deprecated Candidate count retained under the old public name. Use `candidates` for its
   * actual unit and `observed` for backend-created pipelines.
   */
  readonly pipelines: number;
  /** Renderable objects selected for warm-up, before backend cache identity is known. */
  readonly candidates: number;
  /** Number of compileAsync calls attempted, including rejected and timed-out calls. */
  readonly attempted: number;
  /** Backend creation counts observed between the warm-up's start and end snapshots. */
  readonly observed: IWarmUpObservation;
  /** Slices the work was cut into, and therefore the frames the loop got to present. */
  readonly slices: number;
  /** Wall-clock milliseconds the warm-up took, compiling and yielding together. */
  readonly elapsedMs: number;
  /**
   * True when the renderer had no `compileAsync` to call — a WebGL renderer, or a stub.
   *
   * Reported rather than silently skipped: "the warm-up ran and found nothing to do" and "this
   * renderer cannot warm up" produce the same zero, and only one of them is a reason a launch
   * still stalls.
   */
  readonly unsupported: boolean;
  /**
   * Pipelines whose compile never came back inside `compileTimeoutMs`, and pipelines never
   * reached because the whole warm-up ran out of budget.
   *
   * Reported, never thrown. A warm-up is an optimization on the launch path: the one thing it must
   * never do is stop the game from starting, and the first version of this did exactly that — a
   * `compileAsync` that never resolved on the device left `#boot` awaiting forever, so the loop
   * stayed held, the simulation never advanced and the game sat on its loading screen. A launch
   * that is slower than it could be is a disappointment; a launch that never finishes is a bug.
   */
  readonly abandoned: number;
  /** True when the overall budget ran out before every pipeline was warmed. */
  readonly timedOut: boolean;
  /** Compute kernels compiled before the scene pipelines. Present only when computeNodes was set. */
  readonly computeCompiled?: number;
  /** Compute kernels that rejected or exceeded their bound. Present only when computeNodes was set. */
  readonly computeAbandoned?: number;
  /** True when the renderer exposed no computeAsync seam. Present only when computeNodes was set. */
  readonly computeUnsupported?: boolean;
  /** True when compute warm-up consumed the startup budget. Present only when computeNodes was set. */
  readonly computeTimedOut?: boolean;
  /** The optional persistent warm-up hint's outcome. */
  readonly cache?: WarmUpCacheStatus;
  /**
   * The passes the hidden warm render exercised: `main` always, plus `shadow` when a shadow-casting
   * light is present and `reflection` when a reflector node is reachable from a material. Empty when
   * `renderPasses` was off, so an overridden convention still reports what it did. Absent when the
   * renderer exposes no `render` at all.
   */
  readonly passes?: readonly string[];
  /** Backend pipelines observed created by the hidden warm render alone. Absent with `passes`. */
  readonly passPipelines?: number;
  /** Objects whose `frustumCulled` the warm render turned off, so off-screen casters were submitted. */
  readonly cullingForced?: number;
  /** Hidden objects the warm render forced visible (`includeHidden`); zero when it was off. */
  readonly visibilityForced?: number;
}

/** The narrow slice of the renderer this needs. Structural so a test needs no renderer. */
export interface IWarmUpRenderer {
  compileAsync?: (scene: Object3D, camera: Camera, targetScene?: Object3D) => Promise<void>;
  compileComputeAsync?: (node: unknown) => Promise<void>;
  computeAsync?: (node: unknown) => Promise<void>;
  pipelineCensus?: () => IPipelineCensus;
  /**
   * Performs one covered output-pipeline render without marking first present.
   *
   * May settle later than it returns: a renderer whose pipeline creation is asynchronous
   * (Three's `createRenderPipelineAsync` with its pending/skip draw check) starts the work here
   * and resolves once every requested pipeline exists, so the warm-up can wait instead of
   * compiling on the main thread.
   */
  warmUpWorldPass?: (
    scene: Object3D,
    camera: Camera,
    targetScene?: Object3D,
    afterDraw?: () => void,
  ) => void | Promise<void>;
  /** The renderer's own render path, used to build every pass's pipelines once. */
  render?: (scene: Object3D, camera: Camera) => void;
  raw?: unknown;
}

/** The patched static on PMREMNode, reached through a node instance because the native catalog binds no PMREMNode class. */
interface IPMREMNodeClass {
  prepareTextureAsync?(renderer: unknown, texture: Texture): Promise<boolean>;
}

/** The native engine's facade bakes the environment itself; warm-up draws the held scene until it is done. */
interface INativeEnvironmentPreparer {
  prepareEnvironmentAsync(
    scene: Object3D,
    camera: Camera,
    deadlineMs: number,
    afterDraw?: () => void,
  ): Promise<boolean>;
}

function nativeEnvironmentPreparer(raw: unknown): INativeEnvironmentPreparer | undefined {
  return typeof (raw as Partial<INativeEnvironmentPreparer> | null)?.prepareEnvironmentAsync ===
    "function"
    ? (raw as INativeEnvironmentPreparer)
    : undefined;
}

export function sceneNeedsEnvironmentPreparation(
  renderer: IWarmUpRenderer,
  scene: Object3D,
): boolean {
  const environment = (scene as Object3D & { environment?: Texture }).environment;
  if (environment?.isTexture !== true) return false;

  const raw = renderer.raw;
  if (typeof raw !== "object" || raw === null) return false;
  if (nativeEnvironmentPreparer(raw) !== undefined) return true;
  const backend = (raw as { backend?: { isWebGPUBackend?: boolean } }).backend;
  return backend?.isWebGPUBackend === true;
}

export async function prepareSceneEnvironment(
  renderer: IWarmUpRenderer,
  scene: Object3D,
  camera: Camera,
  deadlineMs: number,
  afterDraw?: () => void,
): Promise<boolean> {
  const environment = (scene as Object3D & { environment?: Texture }).environment;
  if (environment?.isTexture !== true) return true;

  const raw = renderer.raw;
  if (typeof raw !== "object" || raw === null) return true;
  const native = nativeEnvironmentPreparer(raw);
  if (native !== undefined)
    return native.prepareEnvironmentAsync(scene, camera, deadlineMs, afterDraw);
  const backend = (raw as { backend?: { isWebGPUBackend?: boolean } }).backend;
  if (backend?.isWebGPUBackend !== true) return true;

  const PMREMNode = pmremTexture(environment).constructor as IPMREMNodeClass;
  const prepare = PMREMNode.prepareTextureAsync;
  if (typeof prepare !== "function") {
    throw new Error(
      "TN_PMREM_ASYNC_PREPARER_UNAVAILABLE: patched Three.js has no PMREM cache preparer.",
    );
  }
  // False at the deadline, as the native preparer does; the bake keeps running. Unbounded, an Action
  // RPG restart on 2-CPU SwiftShader waited the whole sky bake (about 30 s) with no frame drawn.
  const prepared = prepare.call(PMREMNode, raw, environment);
  const remaining = deadlineMs - (globalThis.performance?.now() ?? Date.now());
  if (!Number.isFinite(remaining)) return prepared;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      prepared,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, remaining));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_SLICE_SIZE = 24;
const DEFAULT_COMPILE_TIMEOUT_MS = 2000;
const DEFAULT_BUDGET_MS = 15000;
const WARM_UP_CACHE_SCHEMA = 2;
const WARM_UP_CACHE_PREFIX = "threenative:warm-up:";

interface IWarmUpCacheIdentity {
  readonly key: string;
  readonly storageKey: string;
}

interface IWarmUpCacheRecord {
  readonly schema: number;
  readonly key: string;
  readonly pipelines: number;
  readonly computeNodes: number;
}

function warmUpCacheIdentity(
  cache: IWarmUpCacheOptions | undefined,
): IWarmUpCacheIdentity | undefined {
  if (cache === undefined) return undefined;
  if (
    typeof cache !== "object" ||
    cache === null ||
    typeof cache.key !== "string" ||
    cache.key.trim() === ""
  ) {
    throw new Error(
      "TN_WARMUP_CACHE_INVALID: cache.key must be a non-empty string that changes with the game's render inputs.",
    );
  }
  return { key: cache.key, storageKey: `${WARM_UP_CACHE_PREFIX}${cache.key}` };
}

function warmUpStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === "object" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function readWarmUpCache(
  identity: IWarmUpCacheIdentity | undefined,
  pipelines: number,
  computeNodes: number,
): WarmUpCacheStatus {
  if (identity === undefined) return "disabled";
  const storage = warmUpStorage();
  if (storage === undefined) return "unavailable";
  try {
    const raw = storage.getItem(identity.storageKey);
    if (raw === null) return "miss";
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Partial<IWarmUpCacheRecord>).schema !== WARM_UP_CACHE_SCHEMA ||
      (value as Partial<IWarmUpCacheRecord>).key !== identity.key ||
      (value as Partial<IWarmUpCacheRecord>).pipelines !== pipelines ||
      (value as Partial<IWarmUpCacheRecord>).computeNodes !== computeNodes
    ) {
      storage.removeItem(identity.storageKey);
      return "miss";
    }
    return "hit";
  } catch {
    return "unavailable";
  }
}

function storeWarmUpCache(
  identity: IWarmUpCacheIdentity | undefined,
  pipelines: number,
  computeNodes: number,
): WarmUpCacheStatus {
  if (identity === undefined) return "disabled";
  const storage = warmUpStorage();
  if (storage === undefined) return "unavailable";
  try {
    storage.setItem(
      identity.storageKey,
      JSON.stringify({
        schema: WARM_UP_CACHE_SCHEMA,
        key: identity.key,
        pipelines,
        computeNodes,
      } satisfies IWarmUpCacheRecord),
    );
    return "stored";
  } catch {
    return "unavailable";
  }
}

export interface IComputeWarmUpReport {
  readonly compiled: number;
  readonly abandoned: number;
  readonly unsupported: boolean;
  readonly timedOut: boolean;
}

/** Compiles kernels without running them. */
interface IComputeWarmUpSeam {
  warm(node: unknown): Promise<void>;
}

function computeAsyncOf(renderer: IWarmUpRenderer): IComputeWarmUpSeam | undefined {
  const receiver =
    typeof renderer.compileComputeAsync === "function" ||
    typeof renderer.computeAsync === "function"
      ? renderer
      : renderer.raw;
  if (typeof receiver !== "object" || receiver === null) return undefined;
  const { backend, compileComputeAsync, computeAsync } = receiver as {
    backend?: { isWebGPUBackend?: boolean };
    compileComputeAsync?: (node: unknown) => Promise<void>;
    computeAsync?: (node: unknown, dispatchSize?: number | readonly number[]) => Promise<void>;
  };
  if (backend?.isWebGPUBackend === true) {
    // Three 0.187 compiles a compute pipeline and its bindings without dispatching it
    // (src/renderers/common/Renderer.js:1359, `compileComputeAsync`), so warm-up builds the pipeline
    // the real dispatch uses and nothing runs against the live storage buffers. Dispatching the same
    // kernel with a zeroed count instead made Chrome report `DispatchWorkgroups with a workgroup
    // count of 0 is unusual` once per kernel per warm-up. A renderer without that path reports its
    // kernels as uncompiled rather than silently running them.
    if (typeof compileComputeAsync !== "function") return undefined;
    return { warm: (node) => compileComputeAsync.call(receiver, node) };
  }
  if (typeof computeAsync !== "function") return undefined;
  const plain = computeAsync.bind(receiver);
  return { warm: (node) => plain(node) };
}

/**
 * Resolves when `work` settles or when `limitMs` elapses, whichever comes first.
 *
 * Returns whether the work actually finished, because "compiled" and "gave up waiting" are
 * different facts and the report has to be able to tell them apart.
 */
async function yieldThroughHost(yieldFrame: () => Promise<void>): Promise<void> {
  // Native async pipeline promises are settled from pollEvents(), so awaiting only the compile
  // promise from inside a timer or rAF callback can deadlock the host: the callback cannot return
  // to pollEvents() until the promise settles. Keep the caller's yield signal, and also force one
  // macrotask so tests and browser shims that resolve their signal immediately cannot starve the
  // host timer queue while a compile is still pending.
  await Promise.all([
    Promise.resolve()
      .then(yieldFrame)
      .catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 0)),
  ]);
}

/**
 * @internal Shared with `world-cells.ts`, whose streamed chunks warm up on the same bound: a
 * compile that never settles must not hold an object out of the world for the rest of the session.
 */
export async function within(
  work: Promise<unknown>,
  limitMs: number,
  yieldFrame: () => Promise<void>,
  now: () => number,
): Promise<boolean> {
  return withinDeadline(now() + limitMs, work, yieldFrame, now);
}

// Keep the deadline established before invoking a compiler's synchronous prefix. This does not
// interrupt that work; it prevents the promise wait or cached completion granting extra budget.
async function withinDeadline(
  deadline: number,
  work: Promise<unknown>,
  yieldFrame: () => Promise<void>,
  now: () => number,
): Promise<boolean> {
  // A rejected compile is a pipeline this warm-up could not build, not a reason to fail the
  // launch: the frame that needs it will try again and fail there, where the error belongs.
  let settled: boolean | undefined;
  const completion = work.then(
    () => {
      settled = true;
      return true;
    },
    () => {
      settled = false;
      return false;
    },
  );
  // Do not ask the host for a turn when a normal synchronous or already-cached compile has
  // settled. This preserves the existing slice cadence for fakes and desktop renderers.
  await Promise.resolve();
  if (now() >= deadline) return false;
  if (settled !== undefined) return settled;
  while (now() < deadline) {
    if (settled !== undefined) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, deadline - now());
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
    });
    const result = await Promise.race([
      completion.then((value) => ({ kind: "complete" as const, value })),
      yieldThroughHost(yieldFrame).then(() => ({ kind: "yield" as const })),
      expiry,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timeout") return false;
    if (result.kind === "complete") return now() < deadline && result.value;
  }
  return false;
}

async function runComputeWarmUp(
  renderer: IWarmUpRenderer,
  nodes: readonly unknown[],
  compileTimeoutMs: number,
  deadline: number,
  now: () => number,
  yieldFrame: () => Promise<void>,
): Promise<IComputeWarmUpReport> {
  const seam = computeAsyncOf(renderer);
  if (seam === undefined) {
    return { compiled: 0, abandoned: 0, unsupported: true, timedOut: false };
  }

  let compiled = 0;
  let abandoned = 0;
  let timedOut = false;
  for (let index = 0; index < nodes.length; index += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      timedOut = true;
      abandoned += nodes.length - index;
      break;
    }
    const finished = await withinDeadline(
      Math.min(deadline, now() + compileTimeoutMs),
      Promise.resolve().then(() => seam.warm(nodes[index])),
      yieldFrame,
      now,
    );
    if (finished) compiled += 1;
    else abandoned += 1;
    if (now() >= deadline && (!finished || index + 1 < nodes.length)) {
      timedOut = true;
      abandoned += nodes.length - index - 1;
      break;
    }
  }
  return { compiled, abandoned, unsupported: false, timedOut };
}

/** @internal Compile compute kernels without also compiling a scene's render pipelines. */
export async function warmUpComputeNodes(
  renderer: IWarmUpRenderer,
  nodes: readonly unknown[],
  options: Pick<IWarmUpOptions, "budgetMs" | "compileTimeoutMs" | "yieldFrame"> = {},
): Promise<IComputeWarmUpReport> {
  const compileTimeoutMs = options.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  for (const [name, value] of [
    ["compileTimeoutMs", compileTimeoutMs],
    ["budgetMs", budgetMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `TN_WARMUP_TIMEOUT_INVALID: ${name} must be a positive number of milliseconds, received ${String(value)}.`,
      );
    }
  }
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  return runComputeWarmUp(
    renderer,
    nodes,
    compileTimeoutMs,
    now() + budgetMs,
    now,
    options.yieldFrame ?? yieldToHost,
  );
}

function withComputeReport(report: IWarmUpReport, compute: IComputeWarmUpReport): IWarmUpReport {
  return {
    ...report,
    computeCompiled: compute.compiled,
    computeAbandoned: compute.abandoned,
    computeUnsupported: compute.unsupported,
    computeTimedOut: compute.timedOut,
  };
}

/**
 * Hands the host one loop iteration, so it can present a frame, and never waits on anything.
 *
 * Two wrong versions came before this one, and both are worth keeping written down.
 *
 * Awaiting `requestAnimationFrame` **deadlocks**. Boot is what schedules frames, so on a host
 * where frames are pumped by the same code waiting for boot to finish, the warm-up waits for a
 * callback that cannot run until it stops waiting. The playtest harness is exactly that: its
 * `requestAnimationFrame` pushes the callback onto an array the test drains *after* `start()`
 * resolves. Two suite tests hung for their full timeout.
 *
 * Racing `requestAnimationFrame` against a timer fixes the hang but **registers a frame callback
 * that is not the loop's**, which reorders the frame sequence any harness driving rAF by hand
 * observes. It turned a 16 ms frame into a 32 ms one in the performance suite.
 *
 * So the warm-up asks for no frame at all: it yields the thread and lets the host's own loop do
 * what it was already going to do. On the native runtime — the platform where the 24.5 second
 * stall this exists for actually lives — the host drains `scheduler.yield` continuations in a
 * bounded slice between frames, so frames keep presenting. Nothing is registered, nothing is
 * waited on, and the loop's frame sequence is the one the loop authored.
 */
/**
 * `scheduler.yield` first, where the host has it. A nested `setTimeout(0)` is clamped to 4 ms in
 * Chrome (4.56 ms measured, against 0.009 ms), which left an 8 ms slice idle a third of the time.
 * The native host installs `scheduler.yield` and drains it between frames, while its timer queue
 * is frame-coupled, so a timer yield there costs one whole frame per slice.
 *
 * @internal Shared with `streaming.ts`, whose slices and lanes want the same yield.
 */
export const yieldToHost = (): Promise<void> => {
  const host = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof host?.yield === "function") return host.yield();
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

/**
 * Collects every renderable object in traversal order.
 *
 * Only renderables: a `Group` or a `Bone` carries no material, and compiling it would walk its
 * whole subtree again, turning a linear pass into a quadratic one on a deep scene.
 */
function collectRenderables(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  const stack: Object3D[] = [root];
  while (stack.length > 0) {
    const object = stack.pop() as Object3D;
    // A source the engine merged draws through its merged mesh, which is counted in its place.
    if (
      (object as Object3D & { material?: unknown }).material !== undefined &&
      !isAutoBatchSource(object)
    )
      found.push(object);
    // A structural stand-in for a scene may carry no children at all; count what is there.
    const children = object.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as Object3D);
    }
  }
  return found;
}

function readPipelineCensus(renderer: IWarmUpRenderer): IPipelineCensus | undefined {
  if (typeof renderer.pipelineCensus !== "function") return undefined;
  try {
    return renderer.pipelineCensus();
  } catch {
    return undefined;
  }
}

function censusDelta(
  before: IPipelineCensus | undefined,
  after: IPipelineCensus | undefined,
  key: "creations" | "failures" | "pending" | "uniquePrograms" | "uniquePipelines",
): number {
  if (after === undefined) return 0;
  return Math.max(0, after.counts[key] - (before?.counts[key] ?? 0));
}

function observePipelineCensus(
  before: IPipelineCensus | undefined,
  after: IPipelineCensus | undefined,
): IWarmUpObservation {
  const status: WarmUpObservationStatus =
    after === undefined || after.unsupported
      ? "unavailable"
      : after.complete
        ? "complete"
        : "incomplete";
  return {
    created: censusDelta(before, after, "creations"),
    failed: censusDelta(before, after, "failures"),
    pending: censusDelta(before, after, "pending"),
    uniquePrograms: censusDelta(before, after, "uniquePrograms"),
    uniquePipelines: censusDelta(before, after, "uniquePipelines"),
    status,
  };
}

function reconcileWarmUpObservation(report: IWarmUpReport): IWarmUpReport {
  const unavailable = report.unsupported || report.computeUnsupported === true;
  const incomplete =
    report.abandoned > 0 ||
    report.timedOut ||
    report.computeTimedOut === true ||
    (report.computeAbandoned ?? 0) > 0;
  const status = unavailable
    ? "unavailable"
    : incomplete && report.observed.status === "complete"
      ? "incomplete"
      : report.observed.status;
  return status === report.observed.status
    ? report
    : { ...report, observed: { ...report.observed, status } };
}

/**
 * The renderer state the hidden warm render touches, read structurally so a fake needs no renderer.
 *
 * `autoClear`, `shadowMap.needsUpdate` and the current render target are the three things a render
 * can leave changed; every one of them is restored in a `finally`, so a warm-up can never alter
 * what the game's first real frame draws.
 */
interface IWarmRenderHost {
  autoClear?: boolean;
  shadowMap?: { enabled?: boolean; needsUpdate?: boolean };
  getRenderTarget?: () => unknown;
  setRenderTarget?: (target: unknown) => void;
}

interface IWarmPassRender {
  readonly passes: readonly string[];
  readonly created: number;
  readonly elapsedMs: number;
  readonly cullingForced: number;
  readonly visibilityForced: number;
}

/** The scene-graph state the warm render turns off and must put back exactly. */
interface IWarmVisibilityHost {
  frustumCulled?: boolean;
  visible?: boolean;
}

interface IRestoredVisibility {
  readonly object: IWarmVisibilityHost;
  /** Set only when this warm render turned the object's culling off. */
  readonly frustumCulled?: boolean;
  /** Set only when this warm render forced the object visible. */
  readonly visible?: boolean;
}

/** A shadow map is rendered for every shadow-casting light; nothing else triggers that pass. */
function hasShadowCaster(scene: Object3D): boolean {
  const stack: Object3D[] = [scene];
  while (stack.length > 0) {
    const object = stack.pop() as Object3D & { isLight?: boolean; castShadow?: boolean };
    if (object.isLight === true && object.castShadow === true) return true;
    const children = object.children ?? [];
    for (const child of children) stack.push(child as Object3D);
  }
  return false;
}

interface IReflectorNodeLike {
  readonly isNode?: boolean;
  readonly _reflectorBaseNode?: unknown;
  getChildren?: () => Iterable<unknown>;
}

/**
 * Whether a TSL node graph contains a reflector.
 *
 * Three's `reflector()` hangs a `_reflectorBaseNode` off a `ReflectorNode` that a material's
 * `colorNode` (or a node composed around it) references. The walk is bounded and only descends
 * real nodes, so a material with no reflector costs one shallow pass.
 */
function nodeHasReflector(root: unknown, depth: number): boolean {
  if (depth > 64 || typeof root !== "object" || root === null) return false;
  const node = root as IReflectorNodeLike;
  if (node._reflectorBaseNode !== undefined) return true;
  if (node.isNode !== true || typeof node.getChildren !== "function") return false;
  try {
    for (const child of node.getChildren()) {
      if (nodeHasReflector(child, depth + 1)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasReflector(scene: Object3D): boolean {
  const stack: Object3D[] = [scene];
  // A material is read once however many objects draw with it: on the engine, every field of its
  // values is a call into the host.
  const read = new Set<object>();
  while (stack.length > 0) {
    const object = stack.pop() as Object3D & { material?: unknown };
    const material = object.material;
    if (
      typeof material === "object" &&
      material !== null &&
      (material as { isNodeMaterial?: boolean }).isNodeMaterial === true &&
      !read.has(material)
    ) {
      read.add(material);
      for (const value of Object.values(material as Record<string, unknown>)) {
        if (nodeHasReflector(value, 0)) return true;
      }
    }
    const children = object.children ?? [];
    for (const child of children) stack.push(child as Object3D);
  }
  return false;
}

/**
 * One hidden render of the warm scene, so every pass three will run builds its pipelines now.
 *
 * `compileAsync` covers the main pass only. The shadow map for each shadow-casting light and each
 * reflection pass are created synchronously the first time the scene is drawn — mid-game, on the
 * main thread, inside a frame the player watches. Rendering the scene once here moves that cost
 * behind the startup cover. The render is invisible: `autoClear` is turned off so it cannot wipe a
 * loading frame, and the output stays behind the opaque cover. `shadowMap.needsUpdate` is forced
 * so a game that renders its shadows once (`autoUpdate = false`) still builds them.
 *
 * Frustum culling is turned off for that one render: an object the startup camera cannot see is
 * exactly the object whose shadow and reflection pipelines are missing at startup, so every caster
 * must be submitted. With `includeHidden`, every hidden object is also forced visible, because
 * three never draws a subtree behind a hidden ancestor. Both are restored exactly in a `finally`.
 *
 * Returns `undefined` when the renderer exposes no `render`, so a stub renderer is skipped rather
 * than reported as a pass render that did nothing.
 */
async function renderWarmPasses(
  renderer: IWarmUpRenderer,
  scene: Object3D,
  camera: Camera,
  enabled: boolean,
  includeHidden: boolean,
  targetScene?: Object3D,
  afterCoveredDraw?: () => void,
): Promise<IWarmPassRender | undefined> {
  const coveredWorldPass = renderer.warmUpWorldPass;
  const render =
    coveredWorldPass === undefined
      ? renderer.render === undefined
        ? undefined
        : () => {
            renderer.render?.(scene, camera);
            afterCoveredDraw?.();
          }
      : () => coveredWorldPass(scene, camera, targetScene, afterCoveredDraw);
  if (render === undefined) return undefined;
  const skipped: IWarmPassRender = {
    passes: [],
    created: 0,
    elapsedMs: 0,
    cullingForced: 0,
    visibilityForced: 0,
  };
  // `renderPasses: false` disables optional shadow/reflection work, but an output pipeline's world
  // pass is the shared fallback for a chunk/cell compile and must still be covered once.
  if (!enabled && coveredWorldPass === undefined) return skipped;
  const raw =
    typeof renderer.raw === "object" && renderer.raw !== null
      ? (renderer.raw as IWarmRenderHost)
      : undefined;
  const shadowMap = raw?.shadowMap;
  const passes: string[] = ["main"];
  if (enabled && shadowMap?.enabled !== false && hasShadowCaster(scene)) passes.push("shadow");
  if (enabled && hasReflector(scene)) passes.push("reflection");
  // `compileAsync` already built the main pass. A scene with neither a shadow map nor a reflection
  // has no second pass to build, so rendering it again would only draw a frame the cover hides for
  // nothing. Skip the draw and report the one pass that was compiled.
  if (passes.length === 1 && renderer.warmUpWorldPass === undefined) return { ...skipped, passes };

  const censusBefore = readPipelineCensus(renderer);
  const sceneVisible = (scene as IWarmVisibilityHost).visible;
  const hadOwnAutoClear = raw !== undefined && Object.hasOwn(raw, "autoClear");
  const autoClear = raw?.autoClear;
  const shadowNeedsUpdate = shadowMap?.needsUpdate;
  const previousTarget = raw?.getRenderTarget?.();
  // One walk remembers every original value, so the restore is exact and covers hidden ancestors.
  const restored: IRestoredVisibility[] = [];
  let cullingForced = 0;
  let visibilityForced = 0;
  const stack: Object3D[] = [scene];
  while (stack.length > 0) {
    const object = stack.pop() as Object3D & IWarmVisibilityHost;
    const children = object.children ?? [];
    for (const child of children) stack.push(child as Object3D);
    const entry: { object: IWarmVisibilityHost; frustumCulled?: boolean; visible?: boolean } = {
      object,
    };
    if (object.frustumCulled === true) {
      entry.frustumCulled = true;
      object.frustumCulled = false;
      cullingForced += 1;
    }
    // The root's own visibility is forced below whether or not hidden objects are included, so it
    // is not counted here; a hidden child or group is.
    if (
      includeHidden &&
      object !== scene &&
      object.visible === false &&
      !isAutoBatchSource(object)
    ) {
      entry.visible = false;
      object.visible = true;
      visibilityForced += 1;
    }
    if (entry.frustumCulled !== undefined || entry.visible !== undefined) restored.push(entry);
  }

  const startedAt = globalThis.performance?.now() ?? Date.now();
  try {
    // The render is the mechanism; nothing about the frame it would have drawn is kept.
    if (sceneVisible === false) (scene as IWarmVisibilityHost).visible = true;
    if (raw !== undefined) raw.autoClear = false;
    if (shadowMap !== undefined) shadowMap.needsUpdate = true;
    await render();
  } finally {
    if (raw !== undefined) {
      if (hadOwnAutoClear) raw.autoClear = autoClear;
      else Reflect.deleteProperty(raw, "autoClear");
      if (
        raw.setRenderTarget !== undefined &&
        previousTarget !== undefined &&
        previousTarget !== null
      )
        raw.setRenderTarget(previousTarget);
    }
    if (shadowMap !== undefined) shadowMap.needsUpdate = shadowNeedsUpdate;
    if (sceneVisible === false) (scene as IWarmVisibilityHost).visible = false;
    for (const entry of restored) {
      if (entry.frustumCulled !== undefined) entry.object.frustumCulled = entry.frustumCulled;
      if (entry.visible !== undefined) entry.object.visible = entry.visible;
    }
  }
  return {
    passes,
    created: censusDelta(censusBefore, readPipelineCensus(renderer), "creations"),
    elapsedMs: (globalThis.performance?.now() ?? Date.now()) - startedAt,
    cullingForced,
    visibilityForced,
  };
}

/**
 * Warms up `scene` for `camera`, in slices, presenting a frame between each.
 *
 * Fail closed on a nonsensical slice size rather than quietly choosing one: a zero or negative
 * slice would loop forever, and a caller that passed it has a bug worth seeing now.
 * @situation compile a scene's shaders during the loading screen instead of on the first frame
 * @situation stop a native launch freezing for seconds inside its first rendered frame
 * @example await warmUpScene(renderer, scene, camera, { onProgress: (p) => setLoading(p) });
 */
export async function warmUpScene(
  renderer: IWarmUpRenderer,
  scene: Object3D,
  camera: Camera,
  options: IWarmUpOptions = {},
): Promise<IWarmUpReport> {
  const sliceSize = options.sliceSize ?? DEFAULT_SLICE_SIZE;
  if (!Number.isInteger(sliceSize) || sliceSize < 1) {
    throw new Error(
      `TN_WARMUP_SLICE_INVALID: sliceSize must be a whole number of objects of at least one, received ${String(
        options.sliceSize,
      )}.`,
    );
  }
  const compileTimeoutMs = options.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const environmentBudgetMs = options.environmentBudgetMs ?? STARTUP_HOLD_BUDGET_MS;
  for (const [name, value] of [
    ["compileTimeoutMs", compileTimeoutMs],
    ["budgetMs", budgetMs],
    ["environmentBudgetMs", environmentBudgetMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `TN_WARMUP_TIMEOUT_INVALID: ${name} must be a positive number of milliseconds, received ${String(value)}.`,
      );
    }
  }
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  const yieldFrame = options.yieldFrame ?? yieldToHost;
  const environmentDeadline = now() + environmentBudgetMs;
  // The compile budget's clock; it restarts once the environment is prepared (see `budgetMs`).
  let startedAt = now();
  let environmentPreparationStarted = false;
  let environmentPrepared = false;
  let environmentPreparation: Promise<void> | undefined;
  const ensureEnvironmentPreparation = (
    targetScene: Object3D = options.targetScene ?? scene,
  ): Promise<void> | undefined => {
    if (!sceneNeedsEnvironmentPreparation(renderer, targetScene)) return undefined;
    if (environmentPreparation === undefined) {
      environmentPreparationStarted = true;
      environmentPreparation = prepareSceneEnvironment(
        renderer,
        targetScene,
        camera,
        environmentDeadline,
        options.afterCoveredDraw,
      ).then((prepared) => {
        environmentPrepared = prepared;
        if (!prepared) {
          throw new Error(
            "TN_PMREM_PREPARATION_INCOMPLETE: the scene environment was not prepared.",
          );
        }
      });
    }
    return environmentPreparation;
  };
  const computeNodes = options.computeNodes ?? [];
  const renderables = collectRenderables(scene);
  const candidates = renderables.length;
  const censusBefore = readPipelineCensus(renderer);
  const cacheIdentity = warmUpCacheIdentity(options.cache);
  let cacheStatus = readWarmUpCache(cacheIdentity, candidates, computeNodes.length);

  // Lighting first, on its own budget: every compile below waits on this same preparation, so a
  // bake that outlasts the compile budget must not spend it. Settled or given up, the compile
  // budget starts now.
  const upfront = ensureEnvironmentPreparation();
  if (upfront !== undefined) {
    if (!(await withinDeadline(environmentDeadline, upfront, yieldFrame, now))) {
      // Every compile would wait on this same preparation, so none is started.
      return reconcileWarmUpObservation({
        compiled: 0,
        pipelines: candidates,
        candidates,
        attempted: 0,
        observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
        slices: 0,
        elapsedMs: now() - startedAt,
        unsupported: false,
        abandoned: 1,
        timedOut: now() >= environmentDeadline,
        cache: cacheStatus,
      });
    }
    startedAt = now();
  }

  // A hit means the previous complete warm-up gave the platform a chance to populate its own
  // persistent driver cache. WebGPU has no portable serialized pipeline to restore, so the marker
  // only skips the redundant compile walk; a changed game-owned key is a deliberate invalidation.
  if (cacheStatus === "hit" && typeof renderer.compileAsync === "function") {
    const computeSupported = computeNodes.length === 0 || computeAsyncOf(renderer) !== undefined;
    if (computeSupported) {
      const preparation = ensureEnvironmentPreparation();
      if (
        preparation !== undefined &&
        !(await withinDeadline(startedAt + budgetMs, preparation, yieldFrame, now))
      ) {
        return reconcileWarmUpObservation({
          compiled: 0,
          pipelines: candidates,
          candidates,
          attempted: 0,
          observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
          slices: 0,
          elapsedMs: now() - startedAt,
          unsupported: false,
          abandoned: 1,
          timedOut: now() >= startedAt + budgetMs,
          cache: "hit",
        });
      }
      const report: IWarmUpReport = {
        compiled: 0,
        pipelines: candidates,
        candidates,
        attempted: 0,
        observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
        slices: 0,
        elapsedMs: now() - startedAt,
        unsupported: false,
        abandoned: 0,
        timedOut: false,
        cache: "hit",
        ...(computeNodes.length === 0
          ? {}
          : {
              computeCompiled: 0,
              computeAbandoned: 0,
              computeUnsupported: false,
              computeTimedOut: false,
            }),
      };
      return report;
    }
    cacheStatus = "miss";
  }
  const compute =
    computeNodes.length === 0
      ? undefined
      : await runComputeWarmUp(
          renderer,
          computeNodes,
          compileTimeoutMs,
          startedAt + budgetMs,
          now,
          yieldFrame,
        );

  if (typeof renderer.compileAsync !== "function") {
    const report = reconcileWarmUpObservation({
      compiled: 0,
      pipelines: candidates,
      candidates,
      attempted: 0,
      observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
      slices: 0,
      elapsedMs: now() - startedAt,
      unsupported: true,
      abandoned: 0,
      timedOut: false,
      cache: cacheStatus,
    });
    return compute === undefined
      ? report
      : reconcileWarmUpObservation(withComputeReport(report, compute));
  }
  const compileAsync = renderer.compileAsync.bind(renderer);
  let attempted = 0;
  const invokeCompile = (object: Object3D, targetScene?: Object3D): Promise<void> => {
    const compileDeadline =
      (options.granularity ?? "scene") === "scene"
        ? startedAt + budgetMs
        : Math.min(startedAt + budgetMs, now() + compileTimeoutMs);
    const preparation = ensureEnvironmentPreparation(targetScene ?? scene);
    const compile = (): Promise<void> => {
      if (now() >= compileDeadline) {
        return Promise.reject(
          new Error("TN_WARMUP_COMPILE_DEADLINE: PMREM preparation consumed this compile slice."),
        );
      }
      attempted += 1;
      try {
        return compileAsync(object, camera, targetScene);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return preparation === undefined ? compile() : preparation.then(compile);
  };
  const invokeSceneCompile = (): Promise<void> => {
    const compile = invokeCompile(scene, options.targetScene);
    // Stock Three compileAsync has no render-depth input, so an output pipeline's covered render
    // is the only path that can build the world graph against the target the first frame draws.
    // Its own compile path is still worth running first: it builds every pipeline it can reach
    // asynchronously and yields while it does, so the covered render that follows finds them in
    // the cache. A compile failure here is not fatal: the covered render is the fallback, and the
    // first frame that needs a pipeline will try again where the error belongs.
    if (renderer.warmUpWorldPass === undefined) return compile;
    return compile
      .catch(() => undefined)
      .then(async () => {
        const pass = await renderWarmPassesOnce();
        if (pass === undefined) {
          throw passError ?? new Error("covered world warm render did not settle");
        }
      });
  };

  let gpuDrainSettled = true;
  const finish = (report: IWarmUpReport): IWarmUpReport => {
    const coveredPassIncomplete =
      renderer.warmUpWorldPass !== undefined && passResult === undefined;
    const drainNormalized = gpuDrainSettled
      ? report
      : {
          ...report,
          timedOut: true,
        };
    const normalized = coveredPassIncomplete
      ? {
          ...drainNormalized,
          abandoned: Math.max(1, drainNormalized.abandoned),
          timedOut: drainNormalized.timedOut || now() >= startedAt + budgetMs,
        }
      : drainNormalized;
    const complete =
      gpuDrainSettled &&
      !normalized.unsupported &&
      !normalized.timedOut &&
      normalized.abandoned === 0 &&
      normalized.computeUnsupported !== true &&
      normalized.computeTimedOut !== true &&
      (normalized.computeAbandoned ?? 0) === 0;
    const finalCache =
      complete && cacheIdentity !== undefined
        ? storeWarmUpCache(cacheIdentity, candidates, computeNodes.length)
        : cacheStatus;
    return reconcileWarmUpObservation({ ...normalized, cache: finalCache });
  };

  // The hidden pass render runs once, after the compile and before the ending census snapshot, so
  // the pipelines it builds are counted in `observed` and named beside them. A warm-up that is out
  // of budget does not start it: a render cannot be sliced, and one that overran the launch would
  // be worse than the stall it exists to prevent.
  let passResult: IWarmPassRender | undefined;
  let passRendered = false;
  let passError: unknown;
  const renderWarmPassesOnce = async (): Promise<IWarmPassRender | undefined> => {
    if (passRendered) return passResult;
    passRendered = true;
    if (environmentPreparationStarted && !environmentPrepared) return undefined;
    if (now() >= startedAt + budgetMs) return undefined;
    try {
      passResult = await renderWarmPasses(
        renderer,
        scene,
        camera,
        options.renderPasses !== false,
        options.includeHidden === true,
        options.targetScene,
        options.afterCoveredDraw,
      );
    } catch (error) {
      passError = error;
      passResult = undefined;
    }
    return passResult;
  };
  // `render()` only submits the hidden frame. A driver compiles a pipeline the first time the GPU
  // executes it, so returning here handed that compile to the first frame the player sees: 150 ms
  // for one template's post chain. Wait for the queue to drain, inside the same budget as the rest.
  const settleGpu = async (): Promise<void> => {
    if (passResult === undefined) return;
    const queue = (
      renderer.raw as
        | { backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<unknown> } } } }
        | undefined
    )?.backend?.device?.queue;
    if (typeof queue?.onSubmittedWorkDone !== "function") return;
    const drained = Promise.resolve().then(() => queue.onSubmittedWorkDone?.());
    gpuDrainSettled = await withinDeadline(startedAt + budgetMs, drained, yieldFrame, now);
  };
  const withPasses = (report: IWarmUpReport): IWarmUpReport =>
    passResult === undefined
      ? report
      : {
          ...report,
          passes: passResult.passes,
          passPipelines: passResult.created,
          cullingForced: passResult.cullingForced,
          visibilityForced: passResult.visibilityForced,
          elapsedMs: report.elapsedMs + passResult.elapsedMs,
        };

  // One call, the whole scene: the default, and the only granularity measured to be affordable.
  // It buys no per-pipeline progress reporting because the renderer does not surface any, but an
  // unresolved native promise still yields through `within()` so pollEvents() can settle it. The
  // cost is paid before the loop is released rather than inside the first frame the player sees.
  if ((options.granularity ?? "scene") === "scene") {
    if (compute === undefined) {
      const deadline = startedAt + budgetMs;
      const finished =
        now() < deadline
          ? await withinDeadline(deadline, invokeSceneCompile(), yieldFrame, now)
          : false;
      options.onProgress?.({ done: finished ? 1 : 0, total: 1 });
      await renderWarmPassesOnce();
      await settleGpu();
      return finish(
        withPasses({
          compiled: finished ? 1 : 0,
          pipelines: candidates,
          candidates,
          attempted,
          observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
          slices: 1,
          elapsedMs: now() - startedAt,
          unsupported: false,
          abandoned: finished ? 0 : 1,
          timedOut: !finished && (passError === undefined || now() >= deadline),
        }),
      );
    }
    const remaining = Math.max(0, startedAt + budgetMs - now());
    const finished =
      remaining > 0
        ? await withinDeadline(startedAt + budgetMs, invokeSceneCompile(), yieldFrame, now)
        : false;
    options.onProgress?.({ done: finished ? 1 : 0, total: 1 });
    await renderWarmPassesOnce();
    await settleGpu();
    return finish(
      withPasses(
        withComputeReport(
          {
            compiled: finished ? 1 : 0,
            pipelines: candidates,
            candidates,
            attempted,
            observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
            slices: 1,
            elapsedMs: now() - startedAt,
            unsupported: false,
            abandoned: finished ? 0 : 1,
            timedOut: compute.timedOut || (!finished && now() >= startedAt + budgetMs),
          },
          compute,
        ),
      ),
    );
  }

  const total = renderables.length;
  // Nothing to warm up is a real answer, not a reason to skip the report.
  if (total === 0) {
    options.onProgress?.({ done: 0, total: 0 });
    const report = reconcileWarmUpObservation({
      compiled: 0,
      pipelines: candidates,
      candidates,
      attempted,
      observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
      slices: 0,
      elapsedMs: now() - startedAt,
      unsupported: false,
      abandoned: 0,
      timedOut: false,
    });
    return compute === undefined ? finish(report) : finish(withComputeReport(report, compute));
  }

  let slices = 0;
  let compiled = 0;
  let abandoned = 0;
  let timedOut = false;
  const deadline = startedAt + budgetMs;

  for (let index = 0; index < total; index += 1) {
    if (now() >= deadline) {
      // Out of budget. Everything still unwarmed is abandoned, and says so.
      timedOut = true;
      abandoned += total - index;
      break;
    }
    // Compile every candidate against the real scene so lights, fog and environment resolve
    // exactly as they will when the frame draws. The renderer owns cache reuse and backend
    // identity; this layer must not guess which objects are safe to drop before it observes them.
    //
    // Bounded, because an unbounded await here is what held a real launch open forever.
    const finished = await withinDeadline(
      Math.min(deadline, now() + compileTimeoutMs),
      invokeCompile(renderables[index] as Object3D, options.targetScene ?? scene),
      yieldFrame,
      now,
    );
    if (finished) compiled += 1;
    else {
      abandoned += 1;
      if (now() >= deadline) timedOut = true;
    }

    const done = index + 1;
    if (done % sliceSize === 0 || done === total) {
      slices += 1;
      options.onProgress?.({ done, total });
      // The frame the player actually sees. Skipped after the final slice: the caller is about to
      // render anyway, and one more empty frame would only add to the launch.
      if (done !== total) await yieldFrame();
    }
  }

  // The covered pass can now settle asynchronously too (the post/reflection pipelines it requests
  // are compiled by the device). Bound it by the same budget as every other compile here; the
  // render-only fallback stays a direct call so it costs no extra frame. The pass is always
  // issued, as before; past the budget only the wait is skipped, and its compiles keep landing.
  if (renderer.warmUpWorldPass === undefined) await renderWarmPassesOnce();
  else await withinDeadline(startedAt + budgetMs, renderWarmPassesOnce(), yieldFrame, now);
  await settleGpu();
  const report: IWarmUpReport = {
    compiled,
    pipelines: candidates,
    candidates,
    attempted,
    observed: observePipelineCensus(censusBefore, readPipelineCensus(renderer)),
    slices,
    elapsedMs: now() - startedAt,
    unsupported: false,
    abandoned,
    timedOut,
  };
  return compute === undefined
    ? finish(withPasses(report))
    : finish(
        withPasses(
          withComputeReport({ ...report, timedOut: compute.timedOut || timedOut }, compute),
        ),
      );
}
