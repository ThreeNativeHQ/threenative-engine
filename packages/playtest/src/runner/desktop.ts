import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertDesktopCaptureNotBlank } from "../capture.js";
import type { IDevicePlaytestDriver } from "./androidRunner.js";
import { SCREENSHOT_TIMEOUT_MS as OVERALL_SCREENSHOT_TIMEOUT_MS } from "./shared.js";

/** How long the host may leave a screenshot request untouched before the app counts as hung. */
const SCREENSHOT_TIMEOUT_MS = 5_000;
const SCREENSHOT_REQUEST_FILE = "tn-playtest-screenshot-request.txt";

function nativeScreenshotTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.TN_PLAYTEST_NATIVE_SCREENSHOT_TIMEOUT_MS;
  if (configured === undefined || configured.trim().length === 0) return SCREENSHOT_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : SCREENSHOT_TIMEOUT_MS;
}
const SCREENSHOT_REQUEST_TEMP_FILE = `${SCREENSHOT_REQUEST_FILE}.tmp`;
const HOST_TAIL_LINES = 6;
const HOST_DIAGNOSTIC_LINE = /\[(?:Screenshot|Playtest)\]/u;

export interface IDesktopPlaytestDriverOptions {
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executable: string;
  /** Ask the host for the wall clock, the native counterpart of the browser's init script. */
  liveClock?: boolean;
  mailboxRoot?: string;
  screenshotTimeoutMs?: number;
}

/** A local mailbox implementation with atomic request writes. */
export class LocalDeviceMailbox {
  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      // Windows reports a file the game is replacing as EPERM/EBUSY; it is not written yet, so
      // the poller retries. A lock that never clears still fails at the playtest's own timeout.
      if (isMissingFile(error) || isTransientMailboxLock(error)) return undefined;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    // Node retries EPERM/EBUSY only with recursive mode, which could remove a directory here.
    for (let retry = 0; ; retry += 1) {
      try {
        await rm(path, { force: true });
        return;
      } catch (error) {
        if (retry >= 10 || !isTransientMailboxLock(error)) throw error;
        await delay(20);
      }
    }
  }

  async write(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  }
}

/**
 * Launches a packaged native desktop game and exposes the same driver contract as device runs.
 * The native runtime consumes TN_PLAYTEST_MAILBOX_ROOT before it evaluates the game entry.
 */
export class DesktopPlaytestDriver implements IDevicePlaytestDriver {
  private child?: ChildProcess;
  private childClosed?: Promise<void>;
  private mailboxRoot?: string;
  private readonly consoleEntries: Array<{ text: string; type: string }> = [];
  private readonly pendingOutput = { stderr: "", stdout: "" };

  constructor(private readonly options: IDesktopPlaytestDriverOptions) {}

  /** The child this driver owns; never inferred from a process-name search. */
  get processId(): number | undefined {
    return this.child?.exitCode === null && this.child?.signalCode === null ? this.child.pid : undefined;
  }

  async captureConsole(): Promise<Array<{ text: string; type: string }>> {
    this.flushOutput("stdout");
    this.flushOutput("stderr");
    return [...this.consoleEntries];
  }

  async isAlive(): Promise<boolean> {
    return this.child !== undefined
      && this.child.exitCode === null
      && this.child.signalCode === null;
  }

  async prepare(
    _endpoint: string,
    mailboxRoot?: string,
    viewport?: { height: number; width: number },
  ): Promise<void> {
    if (this.child !== undefined && await this.isAlive()) {
      throw new Error("Desktop playtest executable is already running.");
    }
    this.mailboxRoot = mailboxRoot ?? this.options.mailboxRoot;
    if (this.mailboxRoot === undefined) {
      throw new Error("Desktop playtest requires a local mailbox root.");
    }
    await mkdir(this.mailboxRoot, { recursive: true });
    await Promise.all([
      rm(join(this.mailboxRoot, SCREENSHOT_REQUEST_FILE), { force: true }),
      rm(join(this.mailboxRoot, SCREENSHOT_REQUEST_TEMP_FILE), { force: true }),
    ]);
    this.consoleEntries.length = 0;
    this.pendingOutput.stdout = "";
    this.pendingOutput.stderr = "";
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(process.platform === "linux" && process.env.SDL_VIDEODRIVER === undefined
        ? { SDL_VIDEODRIVER: "x11" }
        : {}),
      MYSTRAL_HEADLESS: "1",
      // A debug launch, because the run's own warning evaluator reads `TN_SCENE_WARNING` and the
      // engine prints it only where a developer asked for the dev surfaces. The shell's value must
      // not decide it: an inherited `DEV_MODE=0` would leave the check blind rather than red.
      DEV_MODE: "1",
      ...this.options.env,
      TN_PLAYTEST_MAILBOX_ROOT: this.mailboxRoot,
      // The host reads the request before it evaluates the game entry, the way the browser runner
      // puts it ahead of every page script. No key when the run asked for no clock. The desktop
      // runner refuses an inherited TN_PLAYTEST_CLOCK before this driver starts, so a counted run
      // never reaches this line with one.
      ...(this.options.liveClock === true ? { TN_PLAYTEST_CLOCK: "wall-clock" } : {}),
    };
    const child = spawn(this.options.executable, [
      ...(this.options.args ?? []),
      ...(viewport === undefined
        ? []
        : ["--width", String(viewport.width), "--height", String(viewport.height), "--windowed"]),
    ], {
      cwd: this.options.cwd,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));
    child.stdout?.on("data", (chunk: Buffer | string) => this.recordOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => this.recordOutput("stderr", chunk));
    try {
      await waitForSpawn(child);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Capture the running game to `path`, returning once the file is written.
   *
   * A deterministic native loop presents nothing between ticks, so the host's copy never happens
   * on its own. `onRequestAccepted` is invoked exactly once, after the host has consumed the
   * request file and therefore set its copy flag; the runner points it at the bridge's render-only
   * operation so the host has a present to copy. It is absent when the bridge offers none, which
   * leaves the pre-existing behavior.
   */
  async screenshot(path: string, onRequestAccepted?: () => Promise<void>): Promise<void> {
    const root = this.mailboxRoot;
    if (root === undefined) throw new Error("Desktop playtest mailbox is unavailable before prepare().");
    if (!(await this.isAlive())) throw new Error("Desktop playtest executable exited before screenshot capture.");
    await rm(path, { force: true });
    const request = join(root, SCREENSHOT_REQUEST_FILE);
    await new LocalDeviceMailbox().write(request, path);
    // Two phases, because two different things bound them. The host deletes the request file the
    // moment it accepts the request (processPlaytestScreenshotRequest in runtime.cpp), so a file
    // still sitting there past the short wait means an app that never serviced the mailbox at all.
    // Once it is gone the host is inside its own budget — a 2s capture wait plus a 5s buffer
    // map — which a software adapter's present can outlast (endDawnFrame p50 333ms, max 4.3s on arm64
    // llvmpipe), so only that phase gets the harness's overall screenshot budget. The sum is the
    // absolute cap, and isAlive() still fails fast inside both.
    const pickupDeadline = Date.now() + (this.options.screenshotTimeoutMs ?? nativeScreenshotTimeoutMs());
    const deadline = pickupDeadline + OVERALL_SCREENSHOT_TIMEOUT_MS;
    let accepted = false;
    let lastReadError: unknown;
    while (Date.now() < deadline) {
      const readError = await tryReadDesktopScreenshot(path);
      if (readError === undefined) return;
      lastReadError = readError;
      if (!(await this.isAlive())) {
        throw new Error("Desktop playtest executable exited before screenshot capture.");
      }
      if (!accepted) {
        accepted = (await new LocalDeviceMailbox().read(request)) === undefined;
        if (accepted && onRequestAccepted !== undefined) await onRequestAccepted();
        if (!accepted && Date.now() >= pickupDeadline) break;
      }
      await delay(25);
    }
    throw new Error(
      `TN_PLAYTEST_NATIVE_SCREENSHOT_UNAVAILABLE: ${await this.describeScreenshotTimeout(request, lastReadError)}`,
    );
  }

  /**
   * Why a screenshot produced no file. The host's own lines are the only place that answer is
   * written, and the request file's presence splits the failure in two: left behind means the host
   * never looked, consumed means it read the request and the capture never landed. A bounded tail,
   * never the whole log — a 40k-line dump is how a timeout becomes unreadable. The tail keeps the
   * host's tagged lines and the entries classified as errors, because the root cause (an EGL
   * failure, a texture that never arrived) is usually an untagged line the tag filter alone drops.
   */
  private async describeScreenshotTimeout(request: string, lastReadError: unknown): Promise<string> {
    this.flushOutput("stdout");
    this.flushOutput("stderr");
    const cause = lastReadError instanceof Error ? lastReadError.message : "request timed out";
    const requestState = await requestFileState(request);
    const diagnostic = this.consoleEntries.filter((entry) =>
      entry.type === "error" || HOST_DIAGNOSTIC_LINE.test(entry.text));
    const tail = (diagnostic.length > 0 ? diagnostic : this.consoleEntries)
      .slice(-HOST_TAIL_LINES)
      .map((entry) => entry.text);
    return `${cause}; ${requestState}; native host output: ${tail.length > 0 ? tail.join(" | ") : "none captured"}`;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!isProcessExited(child) && child.pid !== undefined) {
        terminateProcess(child, "SIGTERM");
        const terminatedByTerm = await waitForExit(child, 2_000);
        if (!terminatedByTerm && !isProcessExited(child)) {
          terminateProcess(child, "SIGKILL");
          const terminatedByKill = await waitForExit(child, 1_000);
          if (!terminatedByKill || !isProcessExited(child)) {
            throw new Error("Desktop playtest executable did not exit after SIGTERM or SIGKILL.");
          }
        } else if (!isProcessExited(child)) {
          throw new Error("Desktop playtest executable did not exit after SIGTERM.");
        }
      }
      await Promise.race([
        this.childClosed,
        new Promise<never>((_, reject) => {
          closeTimeout = setTimeout(() => reject(new Error("Desktop playtest stdout/stderr did not close after exit.")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(closeTimeout);
      this.flushOutput("stdout");
      this.flushOutput("stderr");
    }
  }

  private recordOutput(stream: "stderr" | "stdout", chunk: Buffer | string): void {
    const text = `${this.pendingOutput[stream]}${String(chunk)}`;
    const lines = text.split(/\r?\n/u);
    this.pendingOutput[stream] = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) this.consoleEntries.push({ text: line, type: desktopConsoleType(stream, line) });
    }
  }

  private flushOutput(stream: "stderr" | "stdout"): void {
    const line = this.pendingOutput[stream];
    if (line.length > 0) {
      this.consoleEntries.push({ text: line, type: desktopConsoleType(stream, line) });
      this.pendingOutput[stream] = "";
    }
  }
}

async function tryReadDesktopScreenshot(path: string): Promise<unknown | undefined> {
  try {
    const png = await readFile(path);
    assertDesktopCaptureNotBlank(png, path);
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "CaptureGuardError") throw error;
    return isMissingFile(error) ? "request timed out" : error;
  }
}

export function desktopConsoleType(stream: "stderr" | "stdout", line: string): string {
  const text = line.trimStart();
  // A stream is not a severity: native console.error can use stdout, while GLib/EGL
  // send explicitly labelled warnings to stderr. Keep every line and fail closed on
  // unclassified stderr instead of dropping platform diagnostics to make a run pass.
  if (/^(?:\[error\]|(?:error|fatal):|\[Playtest\] TN_V8_(?:FRAME|UPDATE)_FAILED:)/iu.test(text)) return "error";
  if (
    /^(?:\[warn(?:ing)?\]|warning:|MESA-EGL:\s*warning:|libEGL\s+warning:|\*\* \([^)]*\): WARNING \*\*:|\([^)]*\): dbind-WARNING \*\*:)/iu.test(
      text,
    )
  ) {
    return "warning";
  }
  // A hosted headless runner has no sound card and no accessibility bus, so ALSA and AT-SPI
  // complain about the host, not the game. The same policy Android applies to platform WebView
  // noise (isPlatformWebViewNoise): keep the line, decide only its severity here so a soundless
  // host cannot fail a gameplay qualification. The audio lifecycle is proven by
  // verify-desktop-audio.mjs against real AudioContexts, not by this line.
  if (/^ALSA lib\b|^\[Audio\] Failed to open audio device: ALSA:|^Gtk-Message:/u.test(text)) return "log";
  return stream === "stderr" ? "error" : "log";
}

function terminateProcess(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isProcessExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function isProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientMailboxLock(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "EPERM" || code === "EBUSY";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Reads the request file to name the host's state. Only ENOENT proves the host consumed it;
 * a permission or I/O failure proves nothing about the host, so it is reported as unreadable
 * rather than folded into "consumed" — a wrong label sends the reader to the wrong layer.
 */
async function requestFileState(path: string): Promise<string> {
  try {
    await readFile(path);
    return "request file still present";
  } catch (error) {
    if (isMissingFile(error)) return "request file consumed";
    return `request file unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
