/**
 * Why a launch stopped, said where the player can read it.
 *
 * A launch has exactly two ways to go wrong quietly, and both were measured on a real game:
 * progress stops moving (a decode that never returns, an asset that never settles) and the GPU
 * device is lost (another process had taken 94% of VRAM). In both the loop keeps iterating, the
 * loading layer keeps painting, and the only account of what happened is a line on stdout — which
 * a player does not have, and which a bug report therefore never carries.
 *
 * So the failure is reported as text, once, through `onLaunchFailure` — and core stops there. Core
 * cannot draw it: on the native host `document` is a Three.js compatibility stub whose
 * `appendChild` is a no-op, so an overlay written here would be invisible on exactly the target
 * that needs it. The page owns the presentation (and the copy-to-clipboard button players are
 * asked for when they report a launch that hung); this owns the noticing and the wording.
 */

/** What failed. `stalled` is "no progress for a while"; `device-lost` is the GPU going away. */
export type LaunchFailureKind = "stalled" | "device-lost";

export interface ILaunchFailure {
  readonly kind: LaunchFailureKind;
  /** One human sentence, already naming the numbers — this is what the Copy button copies. */
  readonly message: string;
}

const listeners = new Set<(failure: ILaunchFailure) => void>();
/** One report per kind: a stalled launch keeps stalling, and a wall of identical panels helps no one. */
const reported = new Set<LaunchFailureKind>();

/**
 * Called for every launch failure the engine notices, with the message to show the player.
 *
 * @situation show the player why the game stopped loading instead of leaving the loading screen up
 * @situation report a stalled launch or a lost GPU device in the game's own UI
 * @example const off = onLaunchFailure((failure) => shell.loading({ failure: failure.message }));
 */
export function onLaunchFailure(listener: (failure: ILaunchFailure) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget what has been reported. Tests and a restarting host need a clean slate. */
export function resetLaunchFailures(): void {
  reported.clear();
}

export function reportLaunchFailure(failure: ILaunchFailure): void {
  if (reported.has(failure.kind)) return;
  reported.add(failure.kind);
  const marker = failure.kind === "stalled" ? "TN_STARTUP_STALLED" : "TN_DEVICE_LOST";
  console.error(`${marker}: ${failure.message}`);
  for (const listener of listeners) listener(failure);
}

export interface IStallWatchOptions {
  /** 0..1, monotonic — `ctx.startup.progress`. */
  readonly progress: () => number;
  /** Monotonic completed work units, independent of the displayed percentage. Never elapsed time. */
  readonly workProgress?: () => number;
  /** What is still loading, so the report names it rather than saying "something". */
  readonly pending: () => readonly string[];
  /** How long progress may stand still before this is a failure. */
  readonly stallMs: number;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/**
 * Reports when startup progress stops moving. Returns the stop function; call it at readiness.
 *
 * Polled rather than driven by frames on purpose: the failure this catches is precisely a launch
 * whose frames have become rare, and a frame-driven check would go quiet with them. It still needs
 * the loop to yield — a JavaScript callback that never returns cannot be observed from JavaScript,
 * and that one is the host's `TN_SLOW_PHASE` to report.
 */
export function watchStartupStall(options: IStallWatchOptions): () => void {
  const now = options.now ?? (() => Date.now());
  const start = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const stop = options.clearInterval ?? ((handle) => clearInterval(handle as never));
  if (!(options.stallMs > 0)) {
    throw new Error(`TN_STARTUP_STALL_MS_INVALID: stallMs must be > 0, got ${options.stallMs}`);
  }
  let lastProgress = options.progress();
  let lastWork = options.workProgress?.() ?? 0;
  let lastMovedAt = now();
  const began = lastMovedAt;
  const handle = start(
    () => {
      const progress = options.progress();
      const work = options.workProgress?.() ?? 0;
      if (progress > lastProgress || (Number.isFinite(work) && work > lastWork)) {
        lastProgress = Math.max(lastProgress, progress);
        if (Number.isFinite(work)) lastWork = Math.max(lastWork, work);
        lastMovedAt = now();
        return;
      }
      const stillMs = now() - lastMovedAt;
      if (stillMs < options.stallMs) return;
      const waiting = options.pending();
      const named =
        waiting.length === 0
          ? "nothing — no asset or startup hold is outstanding"
          : waiting.slice(0, 8).join(", ");
      const more = waiting.length > 8 ? ` (+${waiting.length - 8} more)` : "";
      reportLaunchFailure({
        kind: "stalled",
        message:
          `The game stopped loading. No startup work has advanced at ${(progress * 100).toFixed(1)}% for ` +
          `${Math.round(stillMs / 1000)}s, ${Math.round((now() - began) / 1000)}s into the launch.\n` +
          `Still loading: ${named}${more}`,
      });
      stop(handle);
    },
    Math.max(250, Math.min(options.stallMs / 4, 5000)),
  );
  return () => stop(handle);
}

/**
 * Reports a lost GPU device. Every backend that can lose one exposes the same `device.lost`
 * promise; a renderer that has no device yet (or never will) is not an error here.
 */
export function watchDeviceLoss(
  device: { lost?: Promise<{ reason?: string; message?: string }> } | undefined,
): void {
  const lost = device?.lost;
  if (lost === undefined) return;
  void lost.then((info) => {
    // `reason: "destroyed"` is the shutdown path: the game asked for it, so it is not a failure.
    if (info?.reason === "destroyed") return;
    // A real loss always says something — WebGPU requires a reason, and Dawn fills in a message.
    // A resolution carrying neither is a host stub settling its own placeholder promise, which the
    // desktop host does at loop start; reporting that would cry wolf on every launch.
    if (info?.reason === undefined && (info?.message === undefined || info.message === "")) return;
    const cause =
      "Nothing can be drawn after this. The usual causes are another process holding the GPU's " +
      "memory, a driver reset, or a single submission that ran long enough to be killed.";
    const named = info?.reason === undefined ? "" : ` (${info.reason})`;
    reportLaunchFailure({
      kind: "device-lost",
      message: `The GPU device was lost${named}: ${info?.message ?? "no reason given"}\n${cause}`,
    });
  });
}
