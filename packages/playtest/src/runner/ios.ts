import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { IDevicePlaytestDriver } from "./androidRunner.js";

const execFileAsync = promisify(execFile);

export type IosTransportKind = "device" | "simulator";

// `log show --style compact` puts the OS's own severity token before the process, e.g.
// `2026-09-22 15:07:18.517 Df threenative-ios[40455:17a9f] [com.apple.UIKit:AssetManager] ...`.
// The shape is split so the two fields a verdict depends on are captured: the severity token and
// the subsystem. Anything that does not match keeps the textual fallback, so an unrecognised
// format cannot turn a real error green.
const kIosCompactAppleRecord =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ (Df|Db|A|I|E|F) +\S+\[\d+:[0-9a-f]+\] \[([^\]:]+):[^\]]+\]/u;
const kIosExplicitErrorMarker = /\[error\]|\bFATAL\b|GPUValidationError|uncaught/iu;
// Apple stamps `F` on its own slow-launch and timing reports too, so an OS fault is the game
// breaking only when it says something failed (a Metal command buffer aborted due to an error).
const kIosAppleFaultFailure = /\b(?:error|fail(?:ed|ure)?|abort(?:ed)?|crash(?:ed)?)\b/iu;
const kIosTextError = /\[error\]|\b(?:Error|Fault|FATAL|FAILED|GPUValidationError|uncaught)\b/u;

// An Apple-subsystem record is the OS talking about itself. The simulator writes a handful of
// them at every launch -- `com.apple.app_launch_measurement` even stamps its FirstFramePresentation
// record `E` -- and none is the game failing, so an OS record's `E` token is not a console
// error, and its `F` (fault) token is one only when the record reports a failure -- WebKit also
// faults on a slow helper-process launch. The app's own subsystem keeps the severity token as
// authoritative: an `E`/`F` line the app itself logged is an error even when its message carries
// no error keyword. An
// explicit app/JS marker (`[error]`, FATAL, a validation error, an uncaught exception) always
// wins, however the unified log transported it. Unknown format keeps the conservative text scan.
function classifyIosConsoleLine(text: string): "error" | "log" {
  const compact = kIosCompactAppleRecord.exec(text);
  if (compact !== null) {
    if (kIosExplicitErrorMarker.test(text)) return "error";
    if (compact[2]!.startsWith("com.apple.")) {
      return compact[1] === "F" && kIosAppleFaultFailure.test(text) ? "error" : "log";
    }
    if (compact[1] === "E" || compact[1] === "F") return "error";
    return kIosTextError.test(text) ? "error" : "log";
  }
  return kIosTextError.test(text) ? "error" : "log";
}

export interface IIosDriverOptions {
  appPath: string;
  bundleId: string;
  device?: string;
  transport: IosTransportKind;
  xcrunPath?: string;
}

export interface IIosCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export type IRunIosCommand = (
  args: readonly string[],
  options?: IIosCommandOptions,
) => Promise<string>;

export class XcrunIosDriver implements IDevicePlaytestDriver {
  private readonly run: IRunIosCommand;
  private mailboxRoot?: string;
  private pid?: string;
  private suppressedResponse?: string;

  constructor(
    private readonly options: IIosDriverOptions,
    run?: IRunIosCommand,
  ) {
    const xcrun = options.xcrunPath ?? "xcrun";
    this.run = run ?? (async (args, commandOptions = {}) => {
      try {
        const { stdout } = await execFileAsync(xcrun, [...args], {
          encoding: "utf8",
          env: commandOptions.env ?? process.env,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      } catch (error) {
        const detail = error as Error & { stderr?: string; stdout?: string };
        throw new Error(
          `${xcrun} ${args.join(" ")} failed: ${detail.stderr || detail.stdout || detail.message}`,
        );
      }
    });
  }

  async prepare(endpoint: string, mailboxRoot?: string): Promise<void> {
    if (!existsSync(this.options.appPath)) {
      throw new Error(`iOS application bundle was not found at '${this.options.appPath}'.`);
    }
    if (this.options.transport === "simulator") {
      await this.prepareSimulator(endpoint, mailboxRoot);
      return;
    }
    await this.prepareDevice(endpoint, mailboxRoot);
  }

  async captureConsole(): Promise<Array<{ text: string; type: string }>> {
    if (this.pid === undefined) throw new Error("iOS console capture requires a launched process.");
    const predicate = `processIdentifier == ${this.pid}`;
    const output = this.options.transport === "simulator"
      ? await this.run([
          "simctl", "spawn", this.device(), "log", "show", "--style", "compact", "--last", "5m",
          "--predicate", predicate,
        ])
      : await this.run([
          "devicectl", "device", "info", "logs", "--device", this.device(),
          "--last", "5m", "--predicate", predicate,
        ]);
    return output
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((text) => ({ text, type: classifyIosConsoleLine(text) }));
  }

  async isAlive(): Promise<boolean> {
    if (this.pid === undefined) return false;
    try {
      if (this.options.transport === "simulator") {
        process.kill(Number(this.pid), 0);
      } else {
        const output = await this.run(["devicectl", "device", "info", "processes", "--device", this.device()]);
        if (!new RegExp(`\\b${this.pid}\\b`, "u").test(output)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async screenshot(path: string): Promise<void> {
    if (this.options.transport === "simulator") {
      await this.run(["simctl", "io", this.device(), "screenshot", path]);
      return;
    }
    await this.run(["devicectl", "device", "capture", "screen", "--device", this.device(), "--destination", path]);
  }

  async readFile(path: string): Promise<string | undefined> {
    path = this.mailboxPath(path);
    if (this.options.transport === "simulator") {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    const directory = await mkdtemp(join(tmpdir(), "threenative-devicectl-read-"));
    const destination = join(directory, basename(path));
    try {
      await this.run([
        "devicectl", "device", "copy", "from", "--device", this.device(),
        "--domain-type", "appDataContainer", "--domain-identifier", this.options.bundleId,
        "--source", path, "--destination", destination,
      ]);
      const contents = await readFile(destination, "utf8");
      return contents === this.suppressedResponse ? undefined : contents;
    } catch (error) {
      if (/does not exist|No such file|not found/u.test(String(error))) return undefined;
      throw error;
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  async removeFile(path: string): Promise<void> {
    if (this.mailboxRoot === undefined) return;
    path = this.mailboxPath(path);
    if (this.options.transport === "simulator") {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    this.suppressedResponse = await this.readFile(path);
  }

  async stop(): Promise<void> {
    if (this.options.transport === "simulator") {
      await this.run(["simctl", "terminate", this.device(), this.options.bundleId]).catch(() => undefined);
    } else {
      await this.run([
        "devicectl", "device", "process", "terminate", "--device", this.device(), this.options.bundleId,
      ]).catch(() => undefined);
    }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    path = this.mailboxPath(path);
    if (this.options.transport === "simulator") {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.incoming-${process.pid}-${Date.now()}`;
      await writeFile(temporary, contents, "utf8");
      await rename(temporary, path);
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "threenative-devicectl-write-"));
    const source = join(directory, basename(path));
    try {
      await writeFile(source, contents, "utf8");
      await this.run([
        "devicectl", "device", "copy", "to", "--device", this.device(),
        "--domain-type", "appDataContainer", "--domain-identifier", this.options.bundleId,
        "--source", source, "--destination", path,
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  getMailboxRoot(): string {
    if (this.mailboxRoot === undefined) {
      throw new Error("iOS mailbox root is unavailable before prepare().");
    }
    return this.mailboxRoot;
  }

  private async prepareSimulator(endpoint: string, mailboxRoot?: string): Promise<void> {
    const device = this.device();
    await this.run(["simctl", "bootstatus", device, "-b"]);
    const previous = await this.registeredBundlePath(device);
    await this.run(["simctl", "install", device, this.options.appPath]);
    await this.awaitInstalledBundle(device, previous);
    const container = (await this.run([
      "simctl", "get_app_container", device, this.options.bundleId, "data",
    ])).trim();
    if (container.length === 0) throw new Error("simctl returned an empty iOS application data container.");
    this.mailboxRoot = mailboxRoot ?? join(container, "Documents");
    await mkdir(this.mailboxRoot, { recursive: true });
    await this.stop();
    const output = await this.run(["simctl", "launch", "--terminate-running-process", device, this.options.bundleId], {
      env: {
        ...process.env,
        SIMCTL_CHILD_TN_PLAYTEST_ENDPOINT: endpoint,
        SIMCTL_CHILD_TN_PLAYTEST_MAILBOX_ROOT: this.mailboxRoot,
      },
    });
    this.pid = parseLaunchedPid(output);
  }

  private async prepareDevice(endpoint: string, mailboxRoot?: string): Promise<void> {
    if (this.options.device === undefined) {
      throw new Error("Physical iOS playtest requires --device with a devicectl device identifier.");
    }
    this.mailboxRoot = mailboxRoot ?? "Documents";
    await this.run([
      "devicectl", "device", "install", "app", "--device", this.device(), this.options.appPath,
    ]);
    const environment = JSON.stringify({
      TN_PLAYTEST_ENDPOINT: endpoint,
      TN_PLAYTEST_MAILBOX_ROOT: this.mailboxRoot,
    });
    const output = await this.run([
      "devicectl", "device", "process", "launch", "--terminate-existing", "--device", this.device(),
      "--environment-variables", environment, this.options.bundleId,
    ]);
    this.pid = parseLaunchedPid(output);
  }

  // `simctl install` returns while the simulator still lists the replaced bundle, which it has
  // moved to `containermanagerd/Dead/`. A launch in that window starts the previous build: a CI
  // physics scenario ran the input smoke game from a Dead container and failed every assertion.
  // Every reinstall gets a new bundle container, so launch only once the listed path is new.
  private async awaitInstalledBundle(device: string, previous: string | undefined): Promise<void> {
    const deadline = Date.now() + kIosInstallRegistrationMs;
    for (;;) {
      const path = await this.registeredBundlePath(device);
      if (path !== undefined && path !== previous && !path.includes("/Dead/")) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `TN_PLAYTEST_IOS_INSTALL_UNREGISTERED: ${this.options.bundleId} still lists ` +
            `'${path ?? "no bundle"}' ${kIosInstallRegistrationMs} ms after simctl install.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, kIosInstallPollMs));
    }
  }

  private async registeredBundlePath(device: string): Promise<string | undefined> {
    return parseListedBundlePath(await this.run(["simctl", "listapps", device]), this.options.bundleId);
  }

  private device(): string {
    return this.options.device ?? "booted";
  }

  private mailboxPath(path: string): string {
    return this.mailboxRoot === undefined ? path : join(this.mailboxRoot, basename(path));
  }
}

const kIosInstallRegistrationMs = 60_000;
const kIosInstallPollMs = 250;

/** The `Path` `simctl listapps` prints for one bundle identifier, or undefined when it is absent. */
function parseListedBundlePath(output: string, bundleId: string): string | undefined {
  const start = output.indexOf(`"${bundleId}" =`);
  if (start < 0) return undefined;
  const end = output.indexOf("};", start);
  const entry = output.slice(start, end < 0 ? undefined : end);
  return /\bPath = "([^"]+)"/u.exec(entry)?.[1];
}

export function parseLaunchedPid(output: string): string {
  const pid = /(?:pid\s+|:\s*)(\d+)\b/iu.exec(output)?.[1];
  if (pid === undefined) throw new Error(`iOS launch did not report a process id: ${output.trim()}`);
  return pid;
}
