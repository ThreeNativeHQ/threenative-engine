import { PLAYTEST_STARTUP_READY_TIMEOUT_MS, playtestDiagnostic, type IPlaytestBridgeReady, type IPlaytestStartupObservation } from "../index.js";
import { PlaytestBridgeError } from "./bridgeClient.js";


export interface IStartupReadySource {
  readonly description: { readonly capabilities: readonly string[] };
  readiness(): Promise<IPlaytestBridgeReady>;
}

/** Which rule the wait resolved on, so a report never reads as more than it measured. */
export type PlaytestStartupRule = "sustained-frames" | "compile-settled";

export interface IStartupReadyOutcome {
  readonly startup: IPlaytestStartupObservation;
  readonly rule: PlaytestStartupRule;
}

export interface IWaitForStartupReadyOptions {
  readonly bridge: IStartupReadySource;
  /**
   * The operator has declared this lane's adapter is software (`--allow-software`).
   *
   * Readiness always waits for `phase === "ready"` — including the game's own launch holds,
   * because a game that builds its world on `whenReady()` has not run when the lane is observed
   * any earlier. The declaration only changes the *label* the wait reports: a CPU rasteriser
   * reaches `ready` when its bounded frame window expires rather than on five sustained in-budget
   * frames, so the result is reported as `rule: "compile-settled"` and must not be read as a
   * smoothness measurement. It is set only from `--allow-software` / `TN_PLAYTEST_ALLOW_SOFTWARE`,
   * never from a timeout, an adapter guess or any other fallback.
   */
  readonly declaredSoftware?: boolean;
  /**
   * Advances the application. A browser run pumps a frame; a device renders on its own clock and
   * passes a short wait. This is not scenario semantics — no step is being counted here — it is
   * the boundary before the first observation is taken.
   */
  readonly pump: (remainingMs?: number) => Promise<void>;
  /** Authored browser warmup. It runs before the readiness deadline and bounds its own frames. */
  readonly warmup?: () => Promise<void>;
  /**
   * True once the run is being torn down, so the wait stops instead of outliving it.
   *
   * The runner installs SIGINT/SIGTERM handlers that close the browser and remove its profile.
   * Without this, a signal arriving mid-wait left the poll running to its own deadline — up to
   * three minutes — and the teardown behind it did not happen until then. The orphan gate,
   * which kills a run on purpose and then asserts the profile is gone, is exactly the thing
   * that catches it: `before 1, after 3`, with no process holding the directories.
   */
  readonly aborted?: () => boolean;
  /**
   * Whether the process under test is still running, when the caller can tell.
   *
   * A bridge that stops answering has two causes with different owners: a launch that is slow to
   * compile, and a host that is no longer there. `pollStartup` cannot separate them — both look
   * like an operation timeout — so without this the wait treats a crash as "still loading" and
   * spends its whole deadline before blaming the game's loading gate. PR #122's hosted Windows
   * collector is what that reads like: three minutes of silence reported as
   * `Application startup stayed 'unreadable, the bridge kept timing out' for 180000ms`, with no
   * mention of the runtime that had exited seconds in.
   *
   * Only `false` ends the wait. A driver that cannot answer returns `undefined` and the wait is
   * left exactly as it was, because inferring a crash from an unreadable probe would be the
   * implicit fallback the rest of this file refuses to have.
   */
  readonly hostAlive?: () => Promise<boolean | undefined>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Holds until the application says its world is safe to observe, or fails with it named.
 *
 * A fixed-step runner advances ticks as fast as the machine allows, so a scenario's whole step
 * list can complete during a launch that has not finished. Everything the game gates on startup
 * — compute dispatch, the first world present — then never happens inside the run, and the
 * result depends only on how long boot took: the same scenario passed on a workstation and
 * failed in CI with identical tick counts, and captures photographed the loading screen.
 *
 * Waiting a bounded amount for a reported signal removes the race. Padding the scenario with
 * more ticks cannot: ticks are not the clock the loader is on.
 *
 * Returns the startup observation it settled on, or `undefined` for an application that does not
 * report startup at all — a plain Three.js page has no such notion and must keep working.
 */
export async function waitForStartupReady(
  options: IWaitForStartupReadyOptions,
): Promise<IStartupReadyOutcome | undefined> {
  const { bridge, pump } = options;
  if (!bridge.description.capabilities.includes("runtime.startup")) {
    await options.warmup?.();
    return undefined;
  }
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? PLAYTEST_STARTUP_READY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`TN_PLAYTEST_STARTUP_TIMEOUT_INVALID: ${String(options.timeoutMs)}`);
  // Authored warmup runs before the readiness deadline starts. Its frames are bounded one at a time
  // by the runner, so a slow software lane is not capped by the readiness allowance.
  await options.warmup?.();
  const deadline = now() + timeoutMs;
  const aborted = options.aborted ?? (() => false);
  if (aborted()) throw abortedDuringStartup();
  const hostAlive = options.hostAlive ?? (async () => undefined);
  let observed: IPlaytestStartupObservation | typeof BUSY = BUSY;
  const timeoutError = () => new PlaytestBridgeError(playtestDiagnostic(
    "TN_PLAYTEST_STARTUP_NOT_READY",
    `Application startup stayed '${observed === BUSY ? "unreadable, the bridge kept timing out" : observed.phase}' for ${timeoutMs}ms; the run would have observed a game that has not finished loading.`,
    "Let the application reach startup readiness — check that its loading gate can complete headlessly — or remove the runtime.startup capability if it has no startup phase.",
  ));
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      settled = true;
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([expired, (async (): Promise<IStartupReadyOutcome> => {
      if (settled) throw timeoutError();
      if (aborted()) throw abortedDuringStartup();
      if (settled || now() >= deadline) throw timeoutError();
      observed = await pollStartup(bridge);
      // Readiness, never bare compile settlement. A game whose launch holds build its world on
      // `whenReady()` (the puzzle's crate pile is one), so observing at compile settlement catches it
      // mid-load: the runs then assert against a half-built world and fail on state that never had a
      // chance to arrive. The bounded frame window still expires on a CPU rasteriser, so this is at
      // most `STARTUP_STABLE_WINDOW_MS` more per scenario, not a wait the lane can never meet.
      while (observed === BUSY || observed.phase !== "ready") {
        if (settled) throw timeoutError();
        if (aborted()) throw abortedDuringStartup();
        // Only an unreadable bridge asks the question: a host that answers is running by definition,
        // and probing a live one every pump would charge each poll for a process lookup.
        if (observed === BUSY) {
          const alive = await hostAlive();
          if (settled) throw timeoutError();
          if (alive === false) throw hostExitedDuringStartup();
        }
        if (settled || now() >= deadline) {
          throw timeoutError();
        }
        try {
          await pump(deadline - now());
        } catch (error) {
          if (
            error instanceof PlaytestBridgeError &&
            error.diagnostic.code === "TN_PLAYTEST_OPERATION_TIMEOUT"
          ) {
            observed = BUSY;
            continue;
          }
          throw error;
        }
        if (settled || now() >= deadline) throw timeoutError();
        observed = await pollStartup(bridge);
      }
      if (settled || now() >= deadline) throw timeoutError();
      return {
        // A declared software lane reaches `ready` on the bounded window rather than on sustained
        // in-budget frames, so it is labelled for what it is: not a smoothness measurement.
        rule: options.declaredSoftware === true ? "compile-settled" : "sustained-frames",
        startup: observed,
      };
    })()]);
  } finally {
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * The run is going away. Unwind now so the caller's teardown runs, rather than holding the
 * process open for the rest of the deadline while a browser profile sits on disk.
 */
function abortedDuringStartup(): PlaytestBridgeError {
  return new PlaytestBridgeError(playtestDiagnostic(
    "TN_PLAYTEST_STARTUP_ABORTED",
    "The run was torn down while waiting for application startup.",
    "Nothing to fix in the scenario: this is the shutdown path, and the wait yields to it so the browser and its profile are released immediately.",
  ));
}

/**
 * The process is gone, so no amount of further waiting can produce a reading. Say that, rather
 * than letting the deadline expire and name the game's loading gate for a fault it does not have.
 */
function hostExitedDuringStartup(): PlaytestBridgeError {
  return new PlaytestBridgeError(playtestDiagnostic(
    "TN_PLAYTEST_STARTUP_HOST_EXITED",
    "The application exited while the run was waiting for its startup to become readable.",
    "Read the console tail this report carries: the process died during launch, so fix the first native or JavaScript error rather than the scenario's startup wait.",
  ));
}

/** The bridge was too busy to answer this time round. Distinct from any real phase. */
const BUSY = Symbol("startup-busy");

/**
 * One reading, where "the page did not answer in time" means *still starting*.
 *
 * `ready` carries the protocol's operation timeout like every other call, and this is the one
 * caller that makes it during first-use work — precisely when the page's main thread is most
 * likely to be blocked long enough to trip it. Failing the run there would blame the game for
 * being slow to compile, which is the opposite of what this wait is for. The overall deadline
 * still bounds it, so a page that never comes back is still named; only the reason changes.
 */
async function pollStartup(
  bridge: IStartupReadySource,
): Promise<IPlaytestStartupObservation | typeof BUSY> {
  try {
    return await readStartup(bridge);
  } catch (error) {
    if (
      error instanceof PlaytestBridgeError &&
      error.diagnostic.code === "TN_PLAYTEST_OPERATION_TIMEOUT"
    ) {
      return BUSY;
    }
    throw error;
  }
}

/**
 * A bridge that advertises `runtime.startup` and then does not report it is malformed, not
 * "still loading": waiting on it would hang for the whole timeout and then blame the game.
 */
async function readStartup(bridge: IStartupReadySource): Promise<IPlaytestStartupObservation> {
  const ready = await bridge.readiness();
  const startup = ready.startup;
  if (startup === undefined || typeof startup.phase !== "string") {
    // Say what came back. "no startup observation" covers a bridge that omitted the field, one
    // that sent a non-object, and a transport that dropped it in flight — three different faults
    // with three different owners. On the device mailbox this is the only description of the
    // payload anyone gets, because the app's console does not reach the runner.
    const shape =
      ready === null || typeof ready !== "object"
        ? `ready() returned ${ready === null ? "null" : typeof ready}`
        : `ready() returned keys [${Object.keys(ready).sort().join(", ")}] with startup=${
            startup === undefined ? "absent" : JSON.stringify(startup)
          }`;
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_STARTUP_NOT_READY",
      `Bridge advertises 'runtime.startup' but ready() returned no startup observation; ${shape}.`,
      "Report { phase, progress } from the bridge's ready() handler, or stop advertising runtime.startup.",
      { capability: "runtime.startup" },
    ));
  }
  return startup;
}
