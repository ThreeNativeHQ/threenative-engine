import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { IPlaytestPerformanceAssertion } from "../scenario.js";
import { WEBGPU_BROWSER_ARGS } from "./browser.js";

export interface IPlaytestServerConfig {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface IStandalonePlaytestConfig {
  /**
   * Accept a software WebGPU adapter. Off by default: without `--enable-features=Vulkan`, or
   * headless on a host whose GPU the browser will not reach, Chromium serves WebGPU from
   * SwiftShader and nothing errors — the adapter answers, limits look healthy, and the run
   * reports a CPU rasteriser's results. A run that cannot name a hardware adapter is not
   * render evidence, so it fails unless the operator says otherwise.
   */
  allowSoftwareAdapter?: boolean;
  android?: { activity: string; packageName: string; user?: string };
  adbPath?: string;
  /** @see IAndroidDriverOptions.touchRotation */
  touchRotation?: number;
  /**
   * The built artifact this run is about to exercise, for `--build-report` to hash. Set by
   * `--artifact`; desktop and iOS already name theirs, so the flag is refused there.
   */
  artifactPath?: string;
  artifactDirectory: string;
  /**
   * The `<artifact>.build-report.json` a `threenative build` published beside the artifact, carrying
   * the profile's `performanceBudget`. Resolved and proved against the artifact under test before
   * anything launches; its budget is merged into every scenario's `assert.performance`.
   */
  buildReportPath?: string;
  /**
   * Capture the run's `before.png`/`after.png` artifact frames. Default true. A scenario that
   * asserts on a frame still captures one — this only drops the convenience captures every run
   * takes whether or not anything reads them.
   */
  captureArtifactScreenshots?: boolean;
  browserArgs?: readonly string[];
  /** Write a Chrome DevTools `.cpuprofile` for this run (browser and desktop targets). */
  cpuProfilePath?: string;
  device?: string;
  desktop?: { executable: string; hostArgs?: readonly string[] };
  endpoint?: string;
  headless: boolean;
  ios?: { appPath?: string; bundleId: string; transport: "device" | "simulator" };
  judgeMarkerUrl?: string;
  /**
   * Measure the game as it plays, instead of counting the scenario's own ticks.
   *
   * Injects `__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock"` ahead of every page script, so the
   * host's frame pump moves the simulation and `advance` names the span its ticks cover — the
   * browser half of what the native production profile's `--live-clock` already does there. It is
   * a measurement opt-in and never a scenario semantics change: a deterministic scenario is still
   * a count of ticks, and a run that takes this flag reports the clock it measured on.
   */
  liveClock?: boolean;
  mailboxRoot?: string;
  /**
   * The performance ceilings the build report declared, already proved against the artifact under
   * test. Merged into each scenario's `assert.performance`; absent when no report was passed.
   */
  performanceBudget?: IPlaytestPerformanceAssertion;
  port?: number;
  projectPath: string;
  scenarioPath: string;
  scenarioPaths?: readonly string[];
  server?: IPlaytestServerConfig;
  timeoutMs: number;
  target?: "android" | "browser" | "desktop" | "ios";
  trace: boolean;
  url: string;
  xcrunPath?: string;
}

export interface IPlaytestFlagHelp {
  default: string;
  summary: string;
  takesValue: boolean;
  allowDashValue?: boolean;
  repeatable?: boolean;
}

export const PLAYTEST_FLAGS = {
  "--adb": { default: "auto-discover", summary: "absolute adb executable path", takesValue: true },
  "--touch-rotation": {
    default: "read from the device",
    summary: "Android raw-touch rotation (0-3) when the app's window and the display disagree",
    takesValue: true,
  },
  "--allow-software": { default: "false", summary: "accept a software WebGPU adapter as evidence", takesValue: false },
  "--activity": { default: ".MystralActivity", summary: "Android launch activity", takesValue: true },
  "--user": { default: "current foreground Android user", summary: "Android user id for force-stop and launch", takesValue: true },
  "--app": { default: "required for iOS", summary: "built iOS .app bundle", takesValue: true },
  "--artifact": { default: "none (browser and android: with --build-report)", summary: "the built artifact this run exercises, hashed to prove the build report describes it", takesValue: true },
  "--artifacts": { default: "artifacts/playtest", summary: "artifact output directory", takesValue: true },
  "--build-report": { default: "none", summary: "the <artifact>.build-report.json threenative build published; its performanceBudget bounds every scenario, and a stale or foreign report refuses the run", takesValue: true },
  "--no-screenshots": { default: "false", summary: "skip the before/after artifact frames; scenarios that assert on a frame still capture one", takesValue: false },
  "--browser-arg": { allowDashValue: true, default: "none (repeatable)", repeatable: true, summary: "one additional Chromium argument", takesValue: true },
  "--browser-recipe": { default: "none", summary: "named browser recipe (webgpu)", takesValue: true },
  "--cpu-prof": { default: "none", summary: "write a Chrome DevTools .cpuprofile for this run (browser and desktop targets)", takesValue: true },
  "--bundle-id": { default: "dev.threenative.runtime", summary: "iOS application bundle identifier", takesValue: true },
  "--device": { default: "platform default", summary: "Android serial or iOS device identifier", takesValue: true },
  "--executable": { default: "required for desktop", summary: "native desktop game executable", takesValue: true },
  "--endpoint": { default: "http://127.0.0.1:41777/playtest", summary: "device bridge endpoint", takesValue: true },
  "--headed": { default: "false", summary: "show the browser window", takesValue: false },
  "--judge-marker-url": { default: "none", summary: "judge-owned loopback marker URL whose POST failures are not network errors", takesValue: true },
  "--live-clock": { default: "false", summary: "measure the game on its own frame clock (browser and desktop targets); a standing scene is unmeasurable on counted ticks", takesValue: false },
  // `allowDashValue` so a host flag can be passed as one: `--host-arg --ui` is the UI root the
  // overlay serves, and the parser would otherwise read `--ui` as a playtest flag and reject it.
  "--host-arg": { allowDashValue: true, default: "none", repeatable: true, summary: "argument passed to the native desktop host, repeatable", takesValue: true },
  "--mailbox-root": { default: "Android external files directory", summary: "native device mailbox directory", takesValue: true },
  "--ios-transport": { default: "simulator", summary: "iOS transport (simulator or device)", takesValue: true },
  "--project": { default: ".", summary: "project root used to resolve paths", takesValue: true },
  "--package": { default: "com.mystral.engine", summary: "Android application id", takesValue: true },
  "--scenario": { default: "required (or positional; repeatable)", repeatable: true, summary: "scenario JSON path or glob", takesValue: true },
  "--server-command": { default: "none", summary: "command for a managed app server", takesValue: true },
  "--server-timeout": { default: "15000", summary: "managed server readiness timeout in ms", takesValue: true },
  "--timeout": { default: "15000", summary: "page operation timeout in ms", takesValue: true },
  "--target": { default: "browser", summary: "execution target (browser, android, desktop, or ios)", takesValue: true },
  "--trace": { default: "false", summary: "write a Playwright trace", takesValue: false },
  "--url": { default: "http://127.0.0.1:5173 (or a free managed port)", summary: "application URL", takesValue: true },
  "--port": { default: "free when managing a server", summary: "managed server port (0 chooses a free port)", takesValue: true },
  "--xcrun": { default: "auto-discover", summary: "absolute xcrun executable path", takesValue: true },
} as const satisfies Record<string, IPlaytestFlagHelp>;

export class PlaytestCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestCliUsageError";
  }
}

export function formatUsage(): string {
  const flags = Object.entries(PLAYTEST_FLAGS).map(([name, details]) =>
    `  ${name.padEnd(20)} ${details.summary} (default: ${details.default})`,
  );
  return [
    "Usage: threenative-playtest <scenario> [options]",
    "       threenative-playtest --scenario <path> [options]",
    "",
    "Commands:",
    "  doctor                check this machine can run a playtest at all",
    "                        --url <url> also reports the running scene at a glance",
    "                        --device <serial> also reports whether that Android device is",
    "                        cool enough, charged enough and discharging to measure on",
    "                        --capture <path> reads a browser census JSON or native",
    "                        TN_PIPELINE_EVENT log and reports shader compilation contributors",
    "                        --text prints either as a human-readable report;",
    "                        --browser-arg extends the WebGPU recipe, repeatable",
    "  init                  create a starter playtest configuration",
    "  perf                  read TN_FRAME_BUDGET / TN_HOST_GAP from one source and report",
    "                        frame, phase and host-gap windows; window 1 is discarded as",
    "                        startup; exits 2 when not enough steady windows arrived",
    "                        sources (mutually exclusive): --file <log>, --executable <bin>",
    "                        with repeatable --host-arg, or --logcat <serial>",
    "                        bounds: --max-frame-p95 <ms>, --min-fps <fps>",
    "                        --require-windows <n> (default 2), --timeout <s>, --text",
    "                        --allow-virtual-display accepts a frame rate the display did not",
    "                        see (a private Xvfb, or a loop the presentation cap outran); without",
    "                        it such a run prints no fps column and refuses a --min-fps bound",
    "                        --soak <frames> (with --executable, default 1800, minimum 1800) runs",
    "                        that many frames, samples RSS every 100, and fails with",
    "                        TN_SOAK_CRASH or TN_SOAK_RSS_GROWTH past 10% growth after frame 300",
    "  trace                 record a Chrome performance trace of a running game and name the",
    "                        functions inside its slow frames — a percentile says a frame was",
    "                        slow, a trace says which function. Take one BEFORE attributing any",
    "                        frame-rate or stutter complaint to a cause",
    "                        --url <url> (required; start the dev server first)",
    "                        --seconds <n> traced window (default 20), --settle <s> (default 4)",
    "                        --key <KeyName> held while tracing, repeatable (default KeyW);",
    "                        --no-input traces a standing camera and says so",
    "                        --wait-for <js> readiness expression (default the engine's",
    "                        __TN_STARTUP_READY__), --wait-timeout <s>, --no-wait",
    "                        --out <path> raw trace JSON, --stall-ms <n>, --top <n>,",
    "                        --viewport <WxH>, --browser-arg <arg>, --text",
    "                        samples empty same-origin rAF before the game, reports adapter.info,",
    "                        and records invalid depth-pipeline call-site stacks automatically",
    "                        --allow-virtual-display / --allow-software acknowledge a degraded",
    "                        run; a frame rate is never printed from a virtual display, because",
    "                        without vsync that number is wrong rather than missing",
    "                        exits 1 when part of the answer is missing or untrustworthy and 2",
    "                        when no trace was recorded at all",
    "  audio                 look at the game's audio, since nobody can listen to it in CI. Band",
    "                        energy, peak, DC, silence and loop-seam continuity per clip, plus a",
    "                        spectrogram PNG per clip — the numbers are the gate and the picture",
    "                        is what a person looks at when the gate fires. Catches the two",
    "                        defects every other check passes: a hum where a chime should be,",
    "                        and a bed that clicks once a cycle",
    "                        --expect <manifest.json> (required) what the GAME declares its own",
    "                        clips should be; the inspector cannot know a bed is broadband and a",
    "                        chime is bright. Fails closed on a malformed expectation rather",
    "                        than skipping it",
    "                        --dir <dir> every audio file under it must be declared, so a clip",
    "                        added later is not a clip nothing checks",
    "                        --root <dir> resolves manifest paths (default cwd)",
    "                        --out <dir> spectrograms (default artifacts/audio),",
    "                        --no-spectrograms, --text",
    "                        no browser, no display, no capture lock",
    "                        exits 1 when a check failed, 2 when it could not run, and 69 when",
    "                        ffmpeg is absent — \"could not check\" is never a green 0",
    "  tone <png...>          print mean, p1, p50, p99, clip%, black% per PNG and an average row",
    "                        no browser or display; empty/unreadable inputs exit 2",
    "  record-to-scenario    convert a replay recording into a scenario",
    "                        (requires --oracle <json> and --out <json>)",
    "",
    "Options:",
    ...flags,
    "  --help                print this help and exit 0",
    "",
    "Exit codes:",
    "  0  playtest passed",
    "  1  assertions failed",
    "  2  the run never reached assertions",
    "  75  the capture lock timed out — not a test failure; rerun when the queue clears",
    "",
    "A build's own budgets:",
    "  threenative build publishes <artifact>.build-report.json beside the artifact it wrote, and",
    "  --build-report hands that to a run. The report is proved against the artifact under test",
    "  (--artifact on browser and android; --executable / --app on desktop and iOS) and its",
    "  performanceBudget is merged into every scenario's assert.performance, so a ceiling declared",
    "  at build time bounds the run without being retyped into each scenario. A report that is",
    "  malformed, was built for another target, or describes bytes that have since changed exits 2",
    "  with TN_PLAYTEST_BUILD_REPORT_INVALID or TN_PLAYTEST_BUILD_REPORT_STALE — the run measured",
    "  nothing, which is not the same as a game that failed.",
    "",
  ].join("\n");
}

export function parseStandalonePlaytestArgs(argv: readonly string[], cwd = process.cwd()): IStandalonePlaytestConfig {
  const flags = parseFlags(argv);
  const scenarioPatterns = flags.get("--scenario") ?? [positional(argv)].filter((value): value is string => value !== undefined);
  if (scenarioPatterns.length === 0) {
    throw new PlaytestCliUsageError("Missing scenario path. Run: threenative-playtest --scenario playtests/movement.playtest.json --url http://127.0.0.1:5173");
  }
  const urlFlag = flags.get("--url")?.[0];
  const url = urlFlag ?? "http://127.0.0.1:5173";
  const target = flags.get("--target")?.[0] ?? "browser";
  if (target !== "browser" && target !== "android" && target !== "desktop" && target !== "ios") {
    throw new PlaytestCliUsageError(`Unknown target '${target}'. Expected 'browser', 'android', 'desktop', or 'ios'.`);
  }
  const projectPath = resolve(cwd, flags.get("--project")?.[0] ?? ".");
  const serverCommand = flags.get("--server-command")?.[0];
  const requestedPort = readPort(flags.get("--port")?.[0]);
  const urlPort = portFromUrl(url);
  const effectivePort = requestedPort ?? (serverCommand === undefined || urlFlag !== undefined ? urlPort : undefined);
  if (requestedPort !== undefined && requestedPort > 0 && urlFlag !== undefined && urlPort !== undefined && requestedPort !== urlPort) {
    throw new PlaytestCliUsageError(`--port ${requestedPort} conflicts with the port in --url (${urlPort}).`);
  }
  const scenarioPaths = scenarioPatterns.flatMap((pattern) => expandScenarioPattern(projectPath, pattern));
  if (scenarioPaths.length === 0) {
    throw new PlaytestCliUsageError("No scenario files matched the requested patterns.");
  }
  const appPath = flags.get("--app")?.[0];
  const executable = flags.get("--executable")?.[0];
  if (target === "desktop" && executable === undefined) {
    throw new PlaytestCliUsageError("Desktop playtest requires --executable <native-game-executable>.");
  }
  const iosTransport = flags.get("--ios-transport")?.[0] ?? "simulator";
  if (iosTransport !== "simulator" && iosTransport !== "device") {
    throw new PlaytestCliUsageError(`Unknown iOS transport '${iosTransport}'. Expected 'simulator' or 'device'.`);
  }
  const explicitBrowserArgs = flags.get("--browser-arg") ?? [];
  const browserRecipe = flags.get("--browser-recipe")?.[0];
  if (browserRecipe !== undefined && browserRecipe !== "webgpu") {
    throw new PlaytestCliUsageError(`Unknown browser recipe '${browserRecipe}'. Expected 'webgpu'.`);
  }
  if (browserRecipe !== undefined && explicitBrowserArgs.length > 0) {
    throw new PlaytestCliUsageError("Choose --browser-recipe or --browser-arg, not both.");
  }
  const device = flags.get("--device")?.[0];
  const cpuProfilePath = flags.get("--cpu-prof")?.[0];
  const judgeMarkerUrl = flags.get("--judge-marker-url")?.[0];
  if (judgeMarkerUrl !== undefined) {
    let marker: URL;
    try {
      marker = new URL(judgeMarkerUrl);
    } catch {
      throw new PlaytestCliUsageError("--judge-marker-url must be a canonical http://127.0.0.1:<port>/first-frame URL for browser runs.");
    }
    if (
      marker.href !== judgeMarkerUrl || marker.protocol !== "http:" || marker.hostname !== "127.0.0.1" ||
      marker.port === "" || marker.pathname !== "/first-frame" || marker.search !== "" || marker.hash !== "" ||
      marker.username !== "" || marker.password !== "" || target !== "browser" || device !== undefined
    ) {
      throw new PlaytestCliUsageError("--judge-marker-url must be a canonical http://127.0.0.1:<port>/first-frame URL for browser runs.");
    }
  }
  if (target === "browser" && device !== undefined) {
    if (browserRecipe !== undefined) {
      throw new PlaytestCliUsageError("Android Chrome device runs cannot honor --browser-recipe; remove it.");
    }
    if (explicitBrowserArgs.length > 0) {
      throw new PlaytestCliUsageError("Android Chrome device runs cannot honor --browser-arg; remove it.");
    }
    if (argv.includes("--headed")) {
      throw new PlaytestCliUsageError("Android Chrome device runs are already visible on the device and cannot honor --headed; remove it.");
    }
  }
  const liveClock = argv.includes("--live-clock");
  // Fail closed rather than silently measuring on the clock nobody asked for: the device lanes take
  // this switch from the production profile's injected instrumentation, not from this runner, so a
  // flag here would report a wall-clock run that never happened. The native desktop host reads the
  // same request from TN_PLAYTEST_CLOCK, which the desktop runner hands it, so it is accepted here.
  if (liveClock && target !== "browser" && target !== "desktop") {
    throw new PlaytestCliUsageError(`--live-clock runs on the browser and desktop targets only; '${target}' is driven by its own host instrumentation.`);
  }
  const rawTouchRotation = flags.get("--touch-rotation")?.[0];
  // Fail closed rather than defaulting: a mistyped rotation that quietly became 0 would put every
  // injected touch somewhere else and report the game as broken.
  if (rawTouchRotation !== undefined && !/^[0-3]$/u.test(rawTouchRotation)) {
    throw new Error(
      `TN_PLAYTEST_ANDROID_ROTATION_INVALID: --touch-rotation must be 0, 1, 2 or 3, got '${rawTouchRotation}'.`,
    );
  }
  const touchRotation = rawTouchRotation === undefined ? undefined : Number(rawTouchRotation);
  const androidUser = flags.get("--user")?.[0];
  if (androidUser !== undefined && !/^\d+$/u.test(androidUser)) {
    throw new PlaytestCliUsageError(`Android --user must be numeric, got '${androidUser}'.`);
  }
  // The desktop host is launched with no arguments unless the caller names them, so a game
  // bundle reaches it the same way DesktopPlaytestDriver already accepts: `--host-arg run
  // --host-arg dist/game.js`. Without this the CLI could only start a host with no game.
  const hostArgs = flags.get("--host-arg") ?? [];
  const artifact = flags.get("--artifact")?.[0];
  const buildReport = flags.get("--build-report")?.[0];
  if (buildReport !== undefined && artifact === undefined && target !== "desktop" && target !== "ios") {
    throw new PlaytestCliUsageError(
      `--build-report on the ${target} target also needs --artifact <path>: nothing else says which build this run exercises.`,
    );
  }
  const browserArgs =
    explicitBrowserArgs.length > 0
      ? explicitBrowserArgs
      : browserRecipe === "webgpu"
        ? [...WEBGPU_BROWSER_ARGS]
        : [];
  return {
    ...(flags.get("--adb")?.[0] === undefined ? {} : { adbPath: flags.get("--adb")![0] }),
    ...(artifact === undefined ? {} : { artifactPath: artifact }),
    ...(touchRotation === undefined ? {} : { touchRotation }),
    // A scaffolded project's own `test` script is what a user runs, and it deliberately refuses a
    // software adapter — nothing about that should change to suit a runner. But CI has no GPU and
    // still needs to prove the scaffold installs, builds and plays, so the same acceptance the
    // flag expresses is available as an environment variable a workflow can set around an
    // unmodified project. It is not a silent default: the run still reports the adapter it got,
    // and TN_PLAYTEST_SOFTWARE_ADAPTER is suppressed only because someone said so out loud.
    allowSoftwareAdapter:
      argv.includes("--allow-software") || process.env.TN_PLAYTEST_ALLOW_SOFTWARE === "1",
    android: {
      activity: flags.get("--activity")?.[0] ?? ".MystralActivity",
      packageName: flags.get("--package")?.[0] ?? "com.mystral.engine",
      ...(androidUser === undefined ? {} : { user: androidUser }),
    },
    artifactDirectory: resolve(projectPath, flags.get("--artifacts")?.[0] ?? "artifacts/playtest"),
    captureArtifactScreenshots: !argv.includes("--no-screenshots"),
    ...(browserArgs.length === 0 ? {} : { browserArgs }),
    ...(buildReport === undefined ? {} : { buildReportPath: resolve(projectPath, buildReport) }),
    ...(cpuProfilePath === undefined ? {} : { cpuProfilePath: resolve(projectPath, cpuProfilePath) }),
    ...(device === undefined ? {} : { device }),
    ...(executable === undefined
      ? {}
      : {
          desktop: {
            executable: resolve(projectPath, executable),
            ...(hostArgs.length === 0 ? {} : { hostArgs }),
          },
        }),
    endpoint: flags.get("--endpoint")?.[0] ?? "http://127.0.0.1:41777/playtest",
    headless: !argv.includes("--headed"),
    ios: {
      ...(appPath === undefined ? {} : { appPath: resolve(projectPath, appPath) }),
      bundleId: flags.get("--bundle-id")?.[0] ?? "dev.threenative.runtime",
      transport: iosTransport,
    },
    ...(judgeMarkerUrl === undefined ? {} : { judgeMarkerUrl }),
    ...(liveClock ? { liveClock: true } : {}),
    ...(flags.get("--mailbox-root")?.[0] === undefined ? {} : { mailboxRoot: flags.get("--mailbox-root")![0] }),
    ...(serverCommand === undefined
      ? effectivePort === undefined ? {} : { port: effectivePort }
      : { port: effectivePort ?? 0 }),
    projectPath,
    scenarioPath: scenarioPaths[0]!,
    scenarioPaths,
    ...(serverCommand === undefined
      ? {}
      : { server: { command: serverCommand, cwd: projectPath, timeoutMs: readPositiveInteger(flags.get("--server-timeout")?.[0], 15_000) } }),
    timeoutMs: readPositiveInteger(flags.get("--timeout")?.[0], 15_000),
    target,
    trace: argv.includes("--trace"),
    url: requestedPort !== undefined && requestedPort > 0 && (urlFlag === undefined || urlPort === undefined)
      ? withPort(url, requestedPort)
      : url,
    ...(flags.get("--xcrun")?.[0] === undefined ? {} : { xcrunPath: flags.get("--xcrun")![0] }),
  };
}

const SCENARIO_GLOB = /[*?[]/u;

function expandScenarioPattern(projectPath: string, pattern: string): string[] {
  if (!SCENARIO_GLOB.test(pattern)) return [pattern];
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const matches: string[] = [];
  collectScenarioFiles(projectPath, projectPath, matches);
  const matching = matches
    .filter((file) => globMatches(normalizedPattern, file))
    .sort((left, right) => left.localeCompare(right));
  if (matching.length === 0) {
    throw new PlaytestCliUsageError(`Scenario glob '${pattern}' matched no files under '${projectPath}'.`);
  }
  return matching;
}

function collectScenarioFiles(directory: string, root: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      collectScenarioFiles(resolve(directory, entry.name), root, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(relative(root, resolve(directory, entry.name)).replaceAll("\\", "/"));
  }
}

function globMatches(pattern: string, file: string): boolean {
  const patternParts = pattern.split("/");
  const fileParts = file.split("/");
  return matchGlobParts(patternParts, fileParts);
}

function matchGlobParts(pattern: readonly string[], file: readonly string[]): boolean {
  if (pattern.length === 0) return file.length === 0;
  const [head, ...tail] = pattern;
  if (head === "**") {
    return matchGlobParts(tail, file) || (file.length > 0 && matchGlobParts(pattern, file.slice(1)));
  }
  return file.length > 0 && segmentMatches(head ?? "", file[0]!) && matchGlobParts(tail, file.slice(1));
}

function segmentMatches(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += escapeRegExp(character);
  }
  return new RegExp(`${expression}$`, "u").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    return parsed.port === "" ? undefined : Number(parsed.port);
  } catch {
    return undefined;
  }
}

function withPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  const result = parsed.toString();
  return url.endsWith("/") ? result : result.replace(/\/$/u, "");
}

function readPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new PlaytestCliUsageError(`Expected a TCP port from 0 to 65535, received '${value}'.`);
  }
  return parsed;
}

function parseFlags(argv: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--") || name === "--help") continue;
    if (!isPlaytestFlag(name)) throw new PlaytestCliUsageError(`Unknown flag '${name}'. Run threenative-playtest --help.`);
    const details: IPlaytestFlagHelp = PLAYTEST_FLAGS[name];
    if (!details.takesValue) continue;
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith("--") && (!details.allowDashValue || isPlaytestFlag(next)))) {
      throw new PlaytestCliUsageError(`Flag '${name}' requires a value.`);
    }
    flags.set(name, [...(flags.get(name) ?? []), next]);
    index += 1;
  }
  return flags;
}

function positional(argv: readonly string[]): string | undefined {
  return argv.find((value, index) => !value.startsWith("-") && (index === 0 || !argv[index - 1]?.startsWith("--")));
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PlaytestCliUsageError(`Expected a positive integer, received '${value ?? ""}'.`);
  }
  return parsed;
}

function isPlaytestFlag(value: string): value is keyof typeof PLAYTEST_FLAGS {
  return Object.prototype.hasOwnProperty.call(PLAYTEST_FLAGS, value);
}
