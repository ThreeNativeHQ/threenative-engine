// One dev-server wait, because seven of them each had their own deadline and only three checked
// whether the server was still alive. A server that dies at start (a port already in use, a missing
// dependency, a bad flag) left the other four polling a closed port until their deadline ran out —
// 90 to 240 seconds of a lane spent waiting for a process that had already exited.
import type { ChildProcess } from "node:child_process";

/** How long a server gets to answer, and what to call it when it does not. */
export interface IDevServerWait {
  /** The URL that must answer. */
  readonly url: string;
  /**
   * The process that is supposed to answer. When it exits, the wait fails at once: nothing can
   * answer from a dead server, and a deadline that outlives it only wastes the lane's time.
   */
  readonly child?: ChildProcess;
  /** Total wait, in milliseconds. */
  readonly timeoutMs?: number;
  /** Gap between probes, in milliseconds. */
  readonly intervalMs?: number;
  /** What the error calls this server, e.g. `"Visual server"`. */
  readonly label?: string;
  /** Extra context a reader needs to fix it, appended to the refusal. */
  readonly detail?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 100;

/** A dev server that exited before it answered, or one that never answered in time. */
export class DevServerError extends Error {
  constructor(
    readonly code: "TN_DEV_SERVER_EXITED" | "TN_DEV_SERVER_TIMEOUT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DevServerError";
  }
}

/** Whether the child has exited or been signalled: either way it can never answer. */
function isDead(child: ChildProcess | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

/**
 * Resolves when `url` answers, and rejects the moment the server cannot.
 *
 * The message names the server, its URL, and — when the caller has one — the command that fixes it,
 * so a red lane says what to do rather than only that a fetch failed.
 *
 * @situation wait for a dev server to answer without burning the deadline on a server that died
 */
export async function waitForServer(wait: IDevServerWait): Promise<void> {
  const timeoutMs = wait.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = wait.intervalMs ?? DEFAULT_INTERVAL_MS;
  const label = wait.label ?? "Dev server";
  const suffix = wait.detail === undefined ? "" : ` ${wait.detail}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (isDead(wait.child)) {
      const how =
        wait.child?.exitCode === null
          ? `signal ${String(wait.child?.signalCode)}`
          : `code ${String(wait.child?.exitCode)}`;
      throw new DevServerError(
        "TN_DEV_SERVER_EXITED",
        `${label} exited before answering at ${wait.url} (${how}).${suffix}`,
      );
    }
    try {
      const response = await fetch(wait.url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new DevServerError(
    "TN_DEV_SERVER_TIMEOUT",
    `${label} did not answer at ${wait.url} within ${timeoutMs}ms (last: ${lastError}).${suffix}`,
  );
}
