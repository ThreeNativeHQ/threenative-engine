import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { IPlaytestScenario } from "../index.js";
import type { IStandalonePlaytestConfig } from "./config.js";

/**
 * The display half of the capture environment bake-in (abstraction report §2.10).
 *
 * The Layer-1/2/3 saga — headless black canvas, a Wayland session hanging Chromium at 120 s
 * against 175 ms under X11, GPU starvation, blank captures — used to be solved by a wrapper
 * every caller had to remember (`sh scripts/xvfb.sh`). The runner now owns the decision
 * itself: pick a display strategy from the environment, strip the Wayland variables that
 * send Chromium at the wrong windowing system, and provision a *private* Xvfb per run.
 * `scripts/xvfb.sh` stays as a thin compatibility path over the same logic; it is no longer
 * required for playtest runs.
 *
 * On Linux a private Xvfb is the DEFAULT, not the fallback, even when a live X display
 * exists. A run that borrows the operator's desktop opens browser and host windows over
 * whatever they are doing, and a long scenario sweep makes the machine unusable — so the
 * display a run paints on is opt-in, through `TN_PLAYTEST_HOST_DISPLAY`. Opt in when the
 * run genuinely needs the session's real GPU adapter (heavy TSL post chains have been
 * observed falling back to SwiftShader under Xvfb) or when a human wants to watch it.
 *
 * Fail-closed applies here like everywhere else in this package: a run that needs pixels and
 * cannot get a display errors naming the cause. It never falls through to a headless launch
 * whose screenshots are SwiftShader blanks.
 */

export interface IDisplayStrategyHost {
  kind: "host";
}

export interface IDisplayStrategyExisting {
  display: string;
  kind: "existing";
}

export interface IDisplayStrategyPrivateXvfb {
  kind: "private-xvfb";
  screen: string;
}

export type IDisplayStrategy = IDisplayStrategyHost | IDisplayStrategyExisting | IDisplayStrategyPrivateXvfb;

export const DEFAULT_XVFB_SCREEN = "1600x900x24";

/**
 * Set to `1` or `true` to paint on the session's real X display instead of a private Xvfb.
 * Opt-in on purpose: the default must never take over the operator's screen.
 */
export const HOST_DISPLAY_ENV = "TN_PLAYTEST_HOST_DISPLAY";

/** Wayland variables that make Chromium pick the wrong windowing system; stripped from the browser child. */
export const STRIPPED_WAYLAND_VARS = ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE"] as const;

export interface IDisplayDecisionInput {
  env: NodeJS.ProcessEnv;
  /** Availability override. By default, xdpyinfo verifies an authenticated X connection. */
  displaySocketExists?: (display: string) => boolean;
  platform: string;
}

/**
 * Decide where the browser's pixels come from. On Linux that is a private Xvfb unless the
 * caller asked for the session's display with `TN_PLAYTEST_HOST_DISPLAY`, and even then only
 * when an X connection succeeds. An explicit host request fails rather than silently changing
 * the display being measured. A Wayland session never satisfies a run by itself.
 */
export function decideDisplayStrategy(input: IDisplayDecisionInput): IDisplayStrategy {
  if (input.platform !== "linux") return { kind: "host" };
  const privateXvfb: IDisplayStrategy = {
    kind: "private-xvfb",
    screen: input.env.TN_XVFB_SCREEN ?? DEFAULT_XVFB_SCREEN,
  };
  if (!hostDisplayRequested(input.env)) return privateXvfb;
  const display = input.env.DISPLAY;
  if (display === undefined || display.length === 0) {
    throw new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: the requested host display requires DISPLAY.");
  }
  const available = input.displaySocketExists?.(display) ?? x11DisplayIsUsable(display, input.env);
  if (!available) {
    throw new Error(`TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: cannot connect to requested DISPLAY=${display}. Refusing to substitute a private Xvfb.`);
  }
  return { display, kind: "existing" };
}

/** Did the caller explicitly ask to paint on the session's own display? */
export function hostDisplayRequested(env: NodeJS.ProcessEnv): boolean {
  const value = env[HOST_DISPLAY_ENV];
  return value === "1" || value?.toLowerCase() === "true";
}

function x11DisplayIsUsable(display: string, env: NodeJS.ProcessEnv): boolean {
  // Xwayland can listen only on an abstract Unix socket. A filesystem path proves neither
  // availability nor authorization; ask an X client using the browser's session credentials.
  const probe = spawnSync("xdpyinfo", ["-display", display], { env, stdio: "ignore", timeout: 2000 });
  if (probe.error) {
    throw new Error(`TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: cannot verify DISPLAY=${display}: xdpyinfo ${probe.error.message}.`);
  }
  return probe.status === 0;
}

/**
 * Build the environment the browser child launches with whenever this runner owns the
 * display decision: `DISPLAY` pinned to the chosen display and every Wayland variable gone,
 * so Chromium cannot answer the session manager instead of the X server it was pointed at.
 */
export function childEnvForDisplay(env: NodeJS.ProcessEnv, display: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const name of STRIPPED_WAYLAND_VARS) delete child[name];
  child.DISPLAY = display;
  return child;
}

/**
 * Does this run produce pixels at all — headed, screenshotting, or evaluating visual or
 * framebuffer assertions? Only those runs need a display and participate in the capture lock.
 */
export function runNeedsPixels(
  config: Pick<IStandalonePlaytestConfig, "headless">,
  scenario: Pick<IPlaytestScenario, "artifacts" | "assert" | "steps">,
): boolean {
  if (config.headless !== true) return true;
  const takesScreenshot = scenario.artifacts?.screenshots !== false
    || scenario.steps.some(({ screenshot }) => screenshot !== undefined);
  const evaluatesVisual = (scenario.assert?.visual?.length ?? 0) > 0 || (scenario.assert?.tone?.length ?? 0) > 0;
  return takesScreenshot || evaluatesVisual || scenario.assert?.framebufferCoverage !== undefined;
}

export interface IProvideDisplayOptions {
  commandExists?: (command: string) => boolean;
  displaySocketExists?: (display: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  spawnProcess?: typeof spawn;
}

export interface IProvidedDisplay {
  /** The compositing manager this run started, or `undefined` when it started none. */
  compositor: string | undefined;
  /** `undefined` when the host platform provides its own display. */
  display: string | undefined;
  /** Environment to hand the browser child; Wayland variables stripped wherever we decided. */
  env: NodeJS.ProcessEnv;
  release: () => Promise<void>;
  strategy: IDisplayStrategy;
}

/**
 * Provide a display for this run according to `decideDisplayStrategy`, spawning a private
 * Xvfb by default on Linux. An explicitly requested host display must be usable; otherwise
 * the request fails before any substitute display or browser is launched.
 */
export async function provideDisplay(options: IProvideDisplayOptions = {}): Promise<IProvidedDisplay> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const strategy = decideDisplayStrategy({
    displaySocketExists: options.displaySocketExists,
    env,
    platform,
  });
  if (strategy.kind === "host") {
    return {
      compositor: undefined,
      display: undefined,
      env: { ...env },
      release: async () => undefined,
      strategy,
    };
  }
  if (strategy.kind === "existing") {
    // A display that was already here belongs to a desktop session that owns its own
    // compositing selection; taking it would be stealing the user's.
    return {
      compositor: undefined,
      display: strategy.display,
      env: childEnvForDisplay(env, strategy.display),
      release: async () => undefined,
      strategy,
    };
  }
  const commandExists = options.commandExists ?? defaultCommandExists;
  if (!commandExists("Xvfb")) {
    throw new Error(
      "No usable X display is available and Xvfb is not installed, so this pixel-producing run "
        + "cannot start (Debian/Ubuntu 'xvfb', Arch 'xorg-server-xvfb', Fedora "
        + "'xorg-x11-server-Xvfb'). Refusing to render blind.",
    );
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  const xvfb = spawnProcess("Xvfb", [
    "-displayfd",
    "3",
    "-nolisten",
    "tcp",
    // COMPOSITE and SHAPE are what a compositing manager needs before it can blend anything, and
    // the native desktop runtime refuses to attach its UI overlay to a display without one. Xvfb
    // does not enable them by default, so every native UI run on a private display reported
    // `TN_UI_OVERLAY:{"attached":false,"reason":"no compositing manager is running"}` — including
    // the starter template's own shipped native-playtests/react-hud scenario, which failed out of
    // the box on a freshly scaffolded project. A browser run does not care either way.
    "+extension",
    "COMPOSITE",
    "+extension",
    "SHAPE",
    "-screen",
    "0",
    strategy.screen,
  ], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
  // An Xvfb that dies instantly must surface as our named launch error below, not as an
  // unhandled 'error' event taking the whole runner down.
  xvfb.on?.("error", () => undefined);
  try {
    const number = await readXvfbDisplayNumber(xvfb);
    const display = `:${number}`;
    const compositor = await startCompositor(display, { commandExists, env, spawnProcess });
    return {
      compositor: compositor?.name,
      display,
      env: childEnvForDisplay(env, display),
      release: async () => {
        if (compositor !== undefined) await stopChild(compositor.child);
        await stopChild(xvfb);
      },
      strategy,
    };
  } catch (error) {
    await stopChild(xvfb);
    throw error;
  }
}

/**
 * The compositing managers a private display can borrow, and the arguments that make each one
 * plainly composite: no shadows, no fades, nothing that would alter the pixels a scenario
 * asserts on. `picom` and `compton` composite with no arguments and stay in the foreground
 * unless told to daemonise.
 */
const COMPOSITORS: ReadonlyArray<{ args: readonly string[]; name: string }> = [
  { args: ["-n"], name: "xcompmgr" },
  { args: [], name: "picom" },
  { args: [], name: "compton" },
];

/** Long enough for a compositor that lost the selection race to exit and be reported as absent. */
const COMPOSITOR_SETTLE_MS = 250;

/**
 * A private Xvfb has no compositing manager, and nothing else will blend for it: an ARGB window
 * simply draws its own pixels, and a child redirected with `CompositeRedirectAutomatic` still
 * reads back unblended, measured on this server. That is why the native runtime refuses to
 * attach its UI overlay to such a display — so the display we provision starts one, rather than
 * the game process ever becoming a compositor itself.
 *
 * Nothing here is required: a host with no compositing manager installed gets a display without
 * one and the overlay's refusal stands, naming the missing dependency as it always has.
 */
async function startCompositor(
  display: string,
  options: {
    commandExists: (command: string) => boolean;
    env: NodeJS.ProcessEnv;
    spawnProcess: typeof spawn;
  },
): Promise<{ child: ChildProcess; name: string } | undefined> {
  const choice = COMPOSITORS.find(({ name }) => options.commandExists(name));
  if (choice === undefined) return undefined;
  const child = options.spawnProcess(choice.name, [...choice.args], {
    env: { ...options.env, DISPLAY: display },
    stdio: "ignore",
  });
  // A spawn that fails outright reports neither an exit code nor a signal, so the failure has to
  // be remembered: `commandExists` said yes a moment ago and the binary can still be gone by now.
  let spawnFailed = false;
  child.on?.("error", () => {
    spawnFailed = true;
  });
  await new Promise((settle) => setTimeout(settle, COMPOSITOR_SETTLE_MS));
  // A compositor that exited took no selection — most often because one was already held — and
  // reporting it as running would claim a blend nothing performs.
  if (spawnFailed) return undefined;
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return undefined;
  return { child, name: choice.name };
}

const XVFB_DISPLAY_TIMEOUT_MS = 10_000;

/**
 * Xvfb with `-displayfd` picks a free display itself and writes the number to file descriptor
 * 3, which avoids the two-concurrent-gates lock-file race the wrapper also dodges this way.
 */
async function readXvfbDisplayNumber(xvfb: ChildProcess): Promise<number> {
  const report = xvfb.stdio[3];
  if (report === null || report === undefined || typeof (report as NodeJS.ReadableStream).on !== "function") {
    throw new Error("Xvfb was spawned without a display-report descriptor to read.");
  }
  const stream = report as NodeJS.ReadableStream;
  return new Promise<number>((resolveDisplay, rejectDisplay) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("close", onClose);
      settle();
    };
    const onData = (chunk: Buffer | string): void => {
      const number = Number.parseInt(String(chunk).trim(), 10);
      if (Number.isInteger(number) && number >= 0) finish(() => resolveDisplay(number));
    };
    const onClose = (): void => finish(() => rejectDisplay(new Error("Xvfb exited before it reported a display.")));
    const timer = setTimeout(() => finish(() => {
      rejectDisplay(new Error(`Xvfb did not report a display within ${XVFB_DISPLAY_TIMEOUT_MS}ms.`));
    }), XVFB_DISPLAY_TIMEOUT_MS);
    stream.on("data", onData);
    stream.on("close", onClose);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  const exitedAlready = (): boolean => (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
  if (exitedAlready()) return;
  child.kill("SIGTERM");
  const started = Date.now();
  while (Date.now() - started < 1_000 && !exitedAlready()) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (!exitedAlready()) child.kill("SIGKILL");
}

function defaultCommandExists(command: string): boolean {
  // Kept dependency-free: PATH probe instead of `which`, matching how the CLI resolves binaries elsewhere.
  const paths = (process.env.PATH ?? "").split(":").filter((segment) => segment.length > 0);
  return paths.some((directory) => existsSync(join(directory, command)));
}
