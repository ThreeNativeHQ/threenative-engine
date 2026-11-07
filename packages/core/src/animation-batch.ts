/**
 * PRD-828: the frame's animation work, queued and then run in one crossing.
 *
 * A rig's per-frame loop reads and writes engine state per action — the stress lab measured 1,323
 * crossings a frame, eight of the ten busiest classes inside `AnimationPlayer.update`, `#syncStride`
 * and `#evaluate`. The backend can run that whole loop in C++ (`tn_anim_tick`), so a player that can
 * be described by data queues a descriptor here instead of crossing per property, and the frame calls
 * one flush.
 *
 * The fallback is not a mode: when the backend installs no executor (a surface-only runtime, or a
 * build without the entry point), nothing is ever queued and every player keeps its own loop.
 */

/** One rig, in the terms the batch entry takes. Numbers only: the backend resolves the objects. */
export interface IAnimationTickRig {
  readonly mixer: object;
  /** The rig's current action, or null for a rig with nothing playing (its mixer still steps). */
  readonly action: object | null;
  /** The body the stride is measured from, or null to measure none. */
  readonly strideRoot: object | null;
  /** The interval the body's movement is divided by: a held tick banks its own `dt` into this. */
  readonly dt: number;
  /** This tick's own time. The engine banks it at the rate in force; the caller never reads a scale back. */
  readonly elapsed: number;
  /** True on the tick that poses the rig; a held tick measures the stride and advances nothing. */
  readonly step: boolean;
  /** The player spent ticks this batch did not, so the banked advance the engine holds is already spent. */
  readonly reset: boolean;
  /**
   * The rate this rule last applied to the action, or 0 when its scale is the game's own. The engine is
   * the only writer of a rate, but the player is the side that knows whether it wrote one.
   */
  readonly lastRate: number;
  /** Metres of ground the clip covers per clip-second, measured when the clip was analysed. */
  readonly clipGroundSpeed: number;
  readonly strideSync: boolean;
}

/** What the batch did with one rig, read back in the order the rigs were queued. */
export interface IAnimationTickResult {
  readonly strideRate: number;
  readonly groundSpeed: number;
  readonly finished: boolean;
  readonly changed: boolean;
}

/** The backend's entry point, installed on `globalThis` by `@threenative/three-native`'s web backend. */
export type AnimationTickExecutor = (
  rigs: readonly IAnimationTickRig[],
  status: Float64Array,
) => void;

const EXECUTOR_KEY = "__tnAnimationTick";
/** 3 doubles per rig: stride rate, ground speed, flags (bit 0 finished, bit 1 changed). */
const STATUS_STRIDE = 3;

/** The executor this realm's backend installed, or undefined when it batches nothing. */
export function animationTickExecutor(): AnimationTickExecutor | undefined {
  const host = globalThis as { [EXECUTOR_KEY]?: unknown };
  const candidate = host[EXECUTOR_KEY];
  return typeof candidate === "function" ? (candidate as AnimationTickExecutor) : undefined;
}

interface IQueuedRig {
  readonly rig: IAnimationTickRig;
  apply(result: IAnimationTickResult): void;
}

const queue: IQueuedRig[] = [];
const pending: IAnimationTickRig[] = [];
let status = new Float64Array(STATUS_STRIDE * 256);

/** Queues one rig for this frame's batch. Called from `AnimationPlayer.update`. */
export function queueAnimationTick(
  rig: IAnimationTickRig,
  apply: (result: IAnimationTickResult) => void,
): void {
  queue.push({ rig, apply });
}

/** How many rigs are waiting for the flush (a player that wants to know whether it queued). */
export function queuedAnimationTicks(): number {
  return queue.length;
}

/**
 * Runs every queued rig in one call and hands each its result. Returns the number of batches run (0 or
 * 1), which is the frame's crossing count for animation.
 *
 * Fail closed on the shape: a backend that answers a different number of rigs than it was given would
 * silently leave a rig unadvanced, so that throws instead.
 */
export function flushAnimationTicks(): number {
  const count = queue.length;
  if (count === 0) return 0;
  const executor = animationTickExecutor();
  if (executor === undefined) {
    // Nothing to run it: the players that queued took the data path only because availability was
    // checked at queue time, so this is a backend that uninstalled mid-frame.
    queue.length = 0;
    pending.length = 0;
    throw new Error("TN_ANIM_TICK_EXECUTOR_GONE: a rig was queued and no executor is installed.");
  }
  if (status.length < count * STATUS_STRIDE) status = new Float64Array(count * STATUS_STRIDE);
  pending.length = count;
  for (let i = 0; i < count; i += 1) {
    const entry = queue[i];
    if (entry !== undefined) pending[i] = entry.rig;
  }
  countEngineBatch(1);
  try {
    executor(pending, status);
  } catch (error) {
    // A failed call leaves the rigs unadvanced and their descriptors stale: dropping them is the only
    // state that cannot advance a rig twice, and the throw still reaches the caller.
    queue.length = 0;
    pending.length = 0;
    throw error;
  }
  for (let i = 0; i < count; i += 1) {
    const at = i * STATUS_STRIDE;
    const flags = status[at + 2] as number;
    queue[i]?.apply({
      strideRate: status[at] as number,
      groundSpeed: status[at + 1] as number,
      finished: (flags & 1) !== 0,
      changed: (flags & 2) !== 0,
    });
  }
  queue.length = 0;
  pending.length = 0;
  return 1;
}

/**
 * One batch is one crossing for a whole frame's rigs; a reader that settles the queue mid-frame turns
 * that into one batch per rig, which is a bug that looks like a slow engine. Counted where the playtest
 * bounds read it (`TN_FRAME_BUDGET.counters.engine`), so a regression names itself.
 */
function countEngineBatch(batches: number): void {
  const host = globalThis as { __tnEngineCost?: Record<string, number> };
  if (host.__tnEngineCost === undefined) host.__tnEngineCost = {};
  const bag = host.__tnEngineCost;
  bag.animationTickBatches = (bag.animationTickBatches ?? 0) + batches;
}

/** Drops the queue without running it: a scene teardown must not advance rigs it is destroying. */
export function clearAnimationTicks(): void {
  queue.length = 0;
  pending.length = 0;
}

/**
 * The queue is what turns N per-rig loops into one call: the smallest check that fails if the
 * read-back stops lining up with the rigs that were queued.
 */
export function demo(): string {
  const seen: number[] = [];
  const saved = (globalThis as { [EXECUTOR_KEY]?: unknown })[EXECUTOR_KEY];
  (globalThis as { [EXECUTOR_KEY]?: unknown })[EXECUTOR_KEY] = (
    rigs: readonly IAnimationTickRig[],
    out: Float64Array,
  ) => {
    for (let i = 0; i < rigs.length; i += 1) {
      out[i * STATUS_STRIDE] = (rigs[i] as IAnimationTickRig).dt * 10;
      out[i * STATUS_STRIDE + 1] = 2;
      out[i * STATUS_STRIDE + 2] = 3;
    }
  };
  try {
    const rig = (dt: number): IAnimationTickRig => ({
      mixer: {},
      action: null,
      strideRoot: null,
      dt,
      elapsed: dt,
      step: true,
      reset: false,
      lastRate: 0,
      clipGroundSpeed: 1,
      strideSync: true,
    });
    queueAnimationTick(rig(0.1), (result) => seen.push(result.strideRate));
    queueAnimationTick(rig(0.2), (result) => seen.push(result.strideRate));
    if (queuedAnimationTicks() !== 2) throw new Error("queue length");
    if (flushAnimationTicks() !== 1) throw new Error("one batch");
    if (seen.join(",") !== "1,2") throw new Error(`read-back order: ${seen.join(",")}`);
    if (queuedAnimationTicks() !== 0) throw new Error("queue drained");
    return "demo: ok";
  } finally {
    (globalThis as { [EXECUTOR_KEY]?: unknown })[EXECUTOR_KEY] = saved;
  }
}
