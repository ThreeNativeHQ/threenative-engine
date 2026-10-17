import { spawn } from "node:child_process";

export interface IIsolatedRun {
  command: string;
  args: readonly string[];
  /** Positive milliseconds. The child's whole process group is killed when this elapses. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface IIsolatedResult {
  stdout: string;
  stderr: string;
}

/** Thrown when the child was killed by the timeout or the caller, so its output may be partial. */
export class IsolatedKillError extends Error {}

/**
 * Runs one child process in its own process group. Resolves only on exit code 0. A timeout or a
 * cancel kills the whole group, grandchildren included, and rejects once the child has closed.
 * A signal that is already aborted rejects before anything is spawned.
 */
export function runIsolated({
  command,
  args,
  timeoutMs,
  signal,
}: IIsolatedRun): Promise<IIsolatedResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("runIsolated: timeoutMs must be a positive number."));
  }
  if (signal?.aborted) {
    return Promise.reject(
      new IsolatedKillError("runIsolated: child was cancelled before it started."),
    );
  }
  return new Promise((resolve, reject) => {
    // ponytail: POSIX process groups; on Windows only the direct child is killed (taskkill /T if needed).
    const child = spawn(command, [...args], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed: Error | undefined;
    let settled = false;
    const finish = (error?: Error, result?: IIsolatedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(result as IIsolatedResult);
    };
    const stop = (reason: string) => {
      killed ??= new IsolatedKillError(reason);
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The group already exited; `close` below settles the run.
      }
    };
    const timer = setTimeout(
      () => stop(`runIsolated: child timed out after ${timeoutMs} ms and was killed.`),
      timeoutMs,
    );
    const onAbort = () => stop("runIsolated: child was cancelled and was killed.");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (killed !== undefined) finish(killed);
      else if (code === 0) finish(undefined, { stdout, stderr });
      else finish(new Error(`runIsolated: child exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
