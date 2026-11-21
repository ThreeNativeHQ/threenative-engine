import { completionWindowEnvironment } from "./steps.js";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { runDevicePlaytest, type IDevicePlaytestDriver } from "./deviceRunner.js";
import { provideDisplay, type IProvidedDisplay } from "./captureEnvironment.js";
import {
  DesktopPlaytestDriver,
  LocalDeviceMailbox,
  type IDesktopPlaytestDriverOptions,
} from "./desktop.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import {
  DeviceMailboxTransport,
  deviceMailboxPaths,
  type IDevicePlaytestTransport,
} from "./deviceTransport.js";
import { interruptedPlaytestError } from "./shared.js";
import { writeObservationArtifacts, type IStandalonePlaytestReport } from "./runner.js";

export interface IDesktopPlaytestDependencies {
  driver?: IDevicePlaytestDriver;
  /** Builds the driver when one is not injected, so a test can watch what it is given. */
  driverFactory?: (options: IDesktopPlaytestDriverOptions) => IDevicePlaytestDriver;
  mailboxRoot?: string;
  transport?: IDevicePlaytestTransport;
}

/**
 * The binary inside a desktop build output directory, when `--executable` names the directory.
 *
 * The two engines write different shapes there: the owned engine player puts its launcher and its
 * assets under `dist-native/<name>/`, while the `threejs` host writes one flat binary. Accepting the
 * directory for both keeps a kit's `test:native` independent of the chosen engine, which is what a
 * game that flips `engine: "threejs"` needs.
 */
export interface IDesktopLaunchTarget {
  /** Optional arguments that belong to the artifact itself, before any `--host-arg`. */
  readonly args?: readonly string[];
  readonly executable: string;
}

/**
 * The path a desktop playtest launches for an `--executable` argument.
 *
 * Kept as the string-returning entry point it always was; `resolveDesktopLaunch` is the form the
 * runner needs, because the raw Windows player also takes its bundle as an argument.
 */
export async function resolveDesktopExecutable(candidate: string): Promise<string> {
  return (await resolveDesktopLaunch(candidate)).executable;
}

export async function resolveDesktopLaunch(candidate: string): Promise<IDesktopLaunchTarget> {
  let isDirectory = false;
  try {
    isDirectory = (await stat(candidate)).isDirectory();
  } catch {
    // A path the runner cannot stat is passed through unchanged: the driver reports the missing
    // binary with the platform's own message, and a test fixture may name one it never writes.
    return { executable: candidate };
  }
  if (!isDirectory) return { executable: candidate };
  const name = basename(candidate);
  // A Windows build writes its launcher either as `<dir>.exe` (the `threejs` host) or as
  // `<dir>/<name>.exe` (the owned engine), and switching engines leaves the other form behind. The
  // newest artifact is the one the last build produced, so that is the one to launch.
  // Windows cannot spawn the POSIX launcher script the engine packager writes as `<dir>/<name>`, so
  // only executables are candidates there: the packaged player itself, or the `threejs` host.
  const rawPlayerPath = join(candidate, "tn-native-engine-player-v8.exe");
  const candidates =
    process.platform === "win32"
      ? // Compared case-insensitively: on that filesystem a game named like the player IS the
        // player's path, and the canonical spelling must be the one that survives, because the
        // bundle argument is keyed on it.
        [
          ...[`${candidate}.exe`, join(candidate, `${name}.exe`)].filter(
            (launcher) => launcher.toLowerCase() !== rawPlayerPath.toLowerCase(),
          ),
          rawPlayerPath,
        ]
      : // Only the launcher this build wrote: a `.exe` beside it is the other platform's
        // artifact, and a name that itself ends in `.exe` is still the POSIX script.
        [join(candidate, name)];
  // Rank by when the *package* was written, not by the copied binary's own timestamp: the packager
  // copies the player out of the cache, and a copy can carry the cached file's time, which would
  // rank a days-old download above the build that just finished. `game.js` is written by that
  // build and sits beside the engine player, so it is the build's own clock.
  // The raw player is the exact packaged path, never a name prefix: a game called
  // `tn-native-engine-player-racer` is a launcher, and treating it as the player would rank it by
  // the bundle's clock and hand it `game.js` as an argument.
  const rawPlayer = process.platform === "win32" ? rawPlayerPath : undefined;
  const builtAt = (launcher: string): number => {
    const bundle = join(candidate, "game.js");
    if (launcher === rawPlayer && existsSync(bundle)) {
      return statSync(bundle, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    }
    return statSync(launcher, { throwIfNoEntry: false })?.mtimeMs ?? -1;
  };
  const present = candidates
    .filter((launcher) => existsSync(launcher))
    .map((launcher) => ({ launcher, mtimeMs: builtAt(launcher) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (present[0] !== undefined) {
    // The raw engine player needs its bundle as an argument; the launcher scripts find it
    // themselves. Only Windows resolves to the raw player, because its launcher is a POSIX script.
    const bundle = join(candidate, "game.js");
    const args = present[0].launcher === rawPlayer && existsSync(bundle) ? [bundle] : undefined;
    return args === undefined ? { executable: present[0].launcher } : { args, executable: present[0].launcher };
  }
  throw new Error(
    `TN_PLAYTEST_EXECUTABLE_MISSING: ${candidate} is a directory with no ${name} launcher in it; build the game's desktop target again.`,
  );
}

/**
 * Arguments the native desktop host is launched with, from repeatable `--host-arg`.
 * A host that needs none still launches, so an absent list is empty rather than undefined.
 * `--cpu-prof` rides along as the host's own flag (PRD-444).
 */
function desktopHostArgs(config: IStandalonePlaytestConfig): readonly string[] {
  const args = config.desktop?.hostArgs ?? [];
  return config.cpuProfilePath === undefined ? args : [...args, `--cpu-prof=${config.cpuProfilePath}`];
}

export async function runDesktopPlaytest(
  config: IStandalonePlaytestConfig,
  dependencies: IDesktopPlaytestDependencies = {},
): Promise<IStandalonePlaytestReport> {
  if (config.liveClock !== true && process.env.TN_PLAYTEST_CLOCK !== undefined) {
    throw new Error("TN_PLAYTEST_CLOCK: a counted run must not inherit a wall clock; unset TN_PLAYTEST_CLOCK or pass --live-clock.");
  }
  if (process.env.TN_PLAYTEST_COMPLETION_WINDOW_LABEL !== undefined) completionWindowEnvironment("desktop", config.headless);
  const declaredExecutable = config.desktop?.executable;
  if (declaredExecutable === undefined) {
    throw new Error("Desktop playtest requires --executable <native-game-executable>.");
  }
  const launch = dependencies.driver === undefined
    ? await resolveDesktopLaunch(declaredExecutable)
    : { executable: declaredExecutable };
  const executable = launch.executable;
  const abortController = new AbortController();
  const handleSignal = (): void => {
    abortController.abort();
    void startSignalCleanup();
  };
  let mailboxRoot: string | undefined;
  let ownsMailboxRoot = false;
  let providedDisplay: IProvidedDisplay | undefined;
  let driver: IDevicePlaytestDriver | undefined;
  let transport: IDevicePlaytestTransport | undefined;
  let signalCleanup: Promise<void> | undefined;
  let signalCleanupError: Error | undefined;
  let report: IStandalonePlaytestReport | undefined;
  let executionError: unknown;
  let executionFailed = false;

  const startSignalCleanup = (): Promise<void> => {
    if (signalCleanup !== undefined) return signalCleanup;
    if (driver === undefined || transport === undefined) return Promise.resolve();
    const currentDriver = driver;
    const currentTransport = transport;
    signalCleanup = Promise.allSettled([
      Promise.resolve().then(() => currentDriver.stop()),
      Promise.resolve().then(() => currentTransport.close()),
    ]).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) signalCleanupError = cleanupFailure(errors);
    });
    return signalCleanup;
  };

  const awaitSignalCleanup = async (): Promise<void> => {
    await startSignalCleanup();
    if (signalCleanupError !== undefined) throw signalCleanupError;
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    const configuredRoot = dependencies.mailboxRoot ?? config.mailboxRoot;
    const root = configuredRoot === undefined
      ? await mkdtemp(join(tmpdir(), "threenative-playtest-desktop-"))
      : isAbsolute(configuredRoot) ? configuredRoot : resolve(config.projectPath, configuredRoot);
    mailboxRoot = root;
    ownsMailboxRoot = configuredRoot === undefined;
    const paths = deviceMailboxPaths(root);
    if (dependencies.driver === undefined) providedDisplay = await provideDisplay();
    const makeDriver =
      dependencies.driverFactory ?? ((options) => new DesktopPlaytestDriver(options));
    driver = dependencies.driver ?? makeDriver({
      args: [...(launch.args ?? []), ...desktopHostArgs(config)],
      cwd: config.projectPath,
      ...(providedDisplay === undefined ? {} : { env: providedDisplay.env }),
      executable,
      liveClock: config.liveClock === true,
      mailboxRoot: root,
      screenshotTimeoutMs: config.timeoutMs,
    });
    transport = dependencies.transport ?? new DeviceMailboxTransport(
      new LocalDeviceMailbox(),
      paths,
      config.timeoutMs,
    );
    report = await runDevicePlaytest({ ...config, mailboxRoot }, {
      driver,
      mailboxPaths: paths,
      name: "desktop",
      processName: executable,
      transport,
      abortSignal: abortController.signal,
      abortCleanup: awaitSignalCleanup,
    });
    if (abortController.signal.aborted) throw interruptedPlaytestError("desktop");
  } catch (error) {
    executionFailed = true;
    executionError = error;
    if (driver !== undefined) {
      // A failure used to throw away every console line the host had written, so a screenshot
      // that never arrived left only its own tail as evidence. The entries are written to
      // the same `console.json` a passing run writes, and a capture or write failure is dropped
      // rather than replacing the failure the operator is chasing.
      try {
        await mkdir(config.artifactDirectory, { recursive: true });
        await writeObservationArtifacts(config.artifactDirectory, undefined, {
          console: await driver.captureConsole(),
          network: [],
          runtimeTrace: undefined,
        });
      } catch {
        // Reported as nothing: the thrown error is the report.
      }
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (cleanup: () => Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (abortController.signal.aborted) await attemptCleanup(awaitSignalCleanup);
    if (mailboxRoot !== undefined) {
      const root = mailboxRoot;
      const paths = deviceMailboxPaths(root);
      if (ownsMailboxRoot) {
        await attemptCleanup(() => rm(root, { force: true, recursive: true }));
      } else {
        await attemptCleanup(async () => {
          await Promise.all([
            rm(paths.request, { force: true }),
            rm(paths.response, { force: true }),
            rm(`${paths.request}.tmp`, { force: true }),
            rm(`${paths.response}.tmp`, { force: true }),
            rm(join(root, "tn-playtest-screenshot-request.txt"), { force: true }),
            rm(join(root, "tn-playtest-screenshot-request.txt.tmp"), { force: true }),
          ]);
        });
      }
    }
    if (providedDisplay !== undefined) await attemptCleanup(providedDisplay.release);
    if (cleanupErrors.length > 0) {
      if (executionFailed) {
        executionError = cleanupFailure([executionError, ...cleanupErrors]);
      } else {
        executionError = cleanupFailure(cleanupErrors);
        executionFailed = true;
      }
    }
  }
  if (executionFailed) throw executionError;
  if (report === undefined) throw new Error("Desktop playtest did not produce a report.");
  return report;
}

function cleanupFailure(errors: readonly unknown[]): Error {
  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error ? error : new Error(String(error));
  }
  return new AggregateError(errors, "Desktop playtest cleanup failed.");
}
