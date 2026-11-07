// One subprocess runner for the scripts, because eight of them had their own and each got a
// different piece right: some captured stdout, some streamed it, some attached a timeout, one
// swallowed the exit code, and their failures named the command as `cmd arg1 arg2` or as a label or
// not at all. The strictest variant wins here: a non-zero exit always throws, the message always
// names the step and the exit, and stdout is either streamed or captured — never silently dropped.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** How to run one command, and what to call it when it fails. */
export interface IExecOptions {
  /** Working directory. */
  readonly cwd?: string;
  /** Extra environment, merged over `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** What the failure calls this step; the command line when omitted. */
  readonly label?: string;
  /** The failure's code prefix, e.g. `TN_RELEASE_STEP_FAILED`. */
  readonly code?: string;
  /** What the failure adds after its sentence, e.g. what it means for the run. */
  readonly detail?: string;
  /**
   * `"inherit"` (the default) streams the child's output straight to the terminal; `"capture"`
   * collects it, forwards it, and returns it.
   */
  readonly stdio?: "inherit" | "capture";
  /** Kill the child after this long, so a hung build cannot hold a lane open forever. */
  readonly timeoutMs?: number;
}

/**
 * Where to run it: a working directory, or the full options. A bare string is the shape most call
 * sites already had, so moving them here did not renumber their arguments.
 */
export type ExecTarget = string | IExecOptions;

function optionsOf(target: ExecTarget | undefined): IExecOptions {
  if (target === undefined) return {};
  return typeof target === "string" ? { cwd: target } : target;
}

/**
 * Refuses a working directory that is not there.
 *
 * A bare string third argument used to be read as a directory, so a caller that passed a human label
 * ran the command in a folder named after its own progress line — a failure no type can catch,
 * because both are strings. Naming the missing directory turns that into a refusal at the call.
 */
function assertWorkingDirectory(options: IExecOptions, command: string): void {
  if (options.cwd === undefined || existsSync(options.cwd)) return;
  throw new ExecError(
    options.code ?? "TN_EXEC_BAD_CWD",
    `${describe(command, [], options)}: working directory '${options.cwd}' does not exist.`,
    null,
  );
}

/** A command that exited non-zero, timed out, or could not start. */
export class ExecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number | null,
  ) {
    super(`${code}: ${message}`);
    this.name = "ExecError";
  }
}

function describe(command: string, args: readonly string[], options: IExecOptions): string {
  return options.label ?? `${command} ${args.join(" ")}`;
}

function failure(
  command: string,
  args: readonly string[],
  options: IExecOptions,
  exitCode: number | null,
  detail?: string,
  signal?: NodeJS.Signals | null,
): ExecError {
  const how =
    signal !== undefined && signal !== null
      ? `was killed by ${signal}`
      : exitCode === null
        ? "did not start"
        : `exited ${String(exitCode)}`;
  const parts = [detail, options.detail].filter((part) => part !== undefined && part !== "");
  const suffix = parts.length === 0 ? "" : `\n${parts.join(" ")}`;
  return new ExecError(
    options.code ?? "TN_EXEC_FAILED",
    `${describe(command, args, options)} ${how}.${suffix}`,
    exitCode,
  );
}

/**
 * Runs a command to completion, synchronously, and returns its stdout — `""` when it streamed.
 *
 * @situation run a build, a packer or a formatter step and fail the script when it fails
 */
export function run(command: string, args: readonly string[], target?: ExecTarget): string {
  const options = optionsOf(target);
  assertWorkingDirectory(options, command);
  try {
    const output = execFileSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
      maxBuffer: 256 * 1024 * 1024,
      stdio: options.stdio === "capture" ? ["ignore", "pipe", "pipe"] : "inherit",
      timeout: options.timeoutMs,
    });
    // `execFileSync` answers `null` when the child inherited the terminal instead of a pipe.
    return (output as string | null) ?? "";
  } catch (error) {
    const exit = (error as { status?: number | null }).status ?? null;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw failure(command, args, options, exit, stderr);
  }
}

/**
 * The asynchronous twin: streams or captures the child's output and throws when it fails.
 *
 * @situation run a long step — a scaffold, an install, a playtest — and fail the script when it fails
 */
export function runAsync(
  command: string,
  args: readonly string[],
  target?: ExecTarget,
): Promise<string> {
  const options = optionsOf(target);
  // A refusal is a rejected promise, like every other failure of this runner: a caller that awaits
  // does not also need a try/catch around the call.
  try {
    assertWorkingDirectory(options, command);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<string>((resolve, reject) => {
    const capture = options.stdio === "capture";
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    if (capture) {
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk: Buffer) => {
          output += String(chunk);
          process.stdout.write(chunk);
        });
    }
    child.once("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(failure(command, args, options, null, error.message));
    });
    // `close`, not `exit`: `exit` fires when the child ends, `close` when its stdio has drained, and
    // a capture that resolved early would hand back a truncated log.
    child.once("close", (exitCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        reject(
          failure(
            command,
            args,
            options,
            exitCode,
            `Killed after ${String(options.timeoutMs)}ms without finishing.`,
            signal,
          ),
        );
        return;
      }
      if (exitCode === 0) resolve(output);
      else reject(failure(command, args, options, exitCode, undefined, signal));
    });
  });
}
