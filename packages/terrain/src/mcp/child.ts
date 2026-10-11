import { spawn } from "node:child_process";

export interface IIsolatedRun {
  command: string;
  args: readonly string[];
  /** Positive milliseconds. The child is killed when this elapses. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface IIsolatedResult {
  stdout: string;
  stderr: string;
}

/** Runs one child process. Resolves only on exit code 0; kills the child on timeout or cancel. */
export function runIsolated({
  command,
  args,
  timeoutMs,
  signal,
}: IIsolatedRun): Promise<IIsolatedResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("runIsolated: timeoutMs must be a positive number."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
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
      child.kill("SIGKILL");
      finish(new Error(reason));
    };
    const timer = setTimeout(
      () => stop(`runIsolated: child timed out after ${timeoutMs} ms and was killed.`),
      timeoutMs,
    );
    const onAbort = () => stop("runIsolated: child was cancelled and was killed.");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

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
      if (code === 0) finish(undefined, { stdout, stderr });
      else finish(new Error(`runIsolated: child exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
