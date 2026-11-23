/**
 * Reports this game's own failure markers (`TN_*` codes) to ThreeNative (PRD-905), so the code a
 * player hits reaches the team without a bug report: a `console.warn` / `console.error` carrying a
 * `TN_` code, an `error` event or an `unhandledrejection` sends one small event.
 *
 * On by default wherever a game runs, with a named opt-out per seam: `defineGame({ telemetry:
 * false })`, `TN_TELEMETRY=0` (environment, `?tnTelemetry=0`, `__THREENATIVE_TELEMETRY__`) and
 * `DO_NOT_TRACK=1`. A playtest runner's launch is off unless it asks with `tnTelemetry=1`. The one
 * boot line names the seam that turned it off.
 *
 * What leaves is the event the PRD's schema spells: code, level, scrubbed message, game name, engine
 * version, platform, renderer engine, mode and a per-session id. Never a stack, a URL, a path or a
 * person. Telemetry never throws, never sends one event twice and never sends more than 50 a session.
 */
import { type ILaunchFlagSpec, readLaunchFlag } from "./debug.js";
import { getPlatform } from "./platform.js";
import { CORE_VERSION } from "./version.js";

const ENDPOINT = "https://threenative.com/api/telemetry";
/** The engine's marker vocabulary: `TN_SCENE_WARNING`, `TN_ASSET_FAILED`, … */
const MARKER = /\bTN_[A-Z0-9_]+/u;
const MAX_EVENTS = 50;
const MAX_MESSAGE = 200;
const MAX_NAME = 64;
const MAX_BACKEND = 32;

/**
 * The opt-out seams, in the order they are checked: the first one that says off is the one the boot
 * line names. Each spec reads one seam only, so the answer can name it. `TN_TELEMETRY` and the two
 * engine seams are opt-outs whose value says off; `DO_NOT_TRACK` is the W3C spelling, where setting
 * it at all (`DO_NOT_TRACK=1`) is the refusal, so it reads as an opt-in asked "on".
 */
const OVERRIDES: ReadonlyArray<
  readonly [override: string, spec: ILaunchFlagSpec, askedFor: "on" | "off"]
> = [
  ["TN_TELEMETRY", { environment: "TN_TELEMETRY", query: "" }, "off"],
  ["?tnTelemetry=0", { environment: "", query: "tnTelemetry" }, "off"],
  [
    "__THREENATIVE_TELEMETRY__",
    { environment: "", query: "", global: "__THREENATIVE_TELEMETRY__" },
    "off",
  ],
  ["DO_NOT_TRACK", { environment: "DO_NOT_TRACK", query: "" }, "on"],
];

/** `TN_TELEMETRY=1`, `?tnTelemetry=1` or the global set true: the one way back on under a runner. */
const ON_FLAG: ILaunchFlagSpec = {
  environment: "TN_TELEMETRY",
  global: "__THREENATIVE_TELEMETRY__",
  query: "tnTelemetry",
};

type ConsoleMethod = (...args: unknown[]) => void;
type Level = "error" | "warn";
type Listener = (event: unknown) => void;
type Report = (level: Level, text: string) => void;

/** The console methods install replaced, as they were before. */
interface IConsoleScope {
  warn: ConsoleMethod;
  error: ConsoleMethod;
}

/** The event target a host gives as its global, when it has one. */
interface IListenable {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

interface IInstalled {
  readonly console: IConsoleScope;
  readonly sent: Set<string>;
  listeners: Array<readonly [type: string, listener: Listener]>;
  session: string;
  events: number;
}

export interface ITelemetryOptions {
  /** `false` is the `config` seam: `defineGame({ telemetry: false })` (PRD-905). */
  readonly enabled?: false;
}

let installed: IInstalled | undefined;
/** A send that itself warns must not loop: nothing is recorded while an event is being built. */
let sending = false;

/**
 * Starts reporting `TN_*` markers from this game's console and uncaught errors (PRD-905).
 *
 * Prints exactly one `TN_TELEMETRY` line, then wraps `console.warn` and `console.error`. A second
 * call while installed is a no-op; a launch whose opt-out names it, or a host that is neither a
 * browser page nor the native runtime, prints its line and installs nothing.
 */
export function installTelemetry(options: ITelemetryOptions | undefined): void {
  if (installed !== undefined) return;
  const override = offReason(options);
  if (override !== undefined) {
    console.info(`TN_TELEMETRY off (${override})`);
    return;
  }
  if (playtestRunner() && !readLaunchFlag(ON_FLAG)) {
    console.info("TN_TELEMETRY off (playtest)");
    return;
  }
  const platform = telemetryPlatform();
  if (platform === undefined) {
    console.info("TN_TELEMETRY off (no platform)");
    return;
  }
  const state: IInstalled = {
    console: { error: console.error, warn: console.warn },
    events: 0,
    listeners: [],
    sent: new Set(),
    session: newSession(),
  };
  const record: Report = (level, text) => {
    if (sending) return;
    const code = MARKER.exec(text)?.[0];
    if (code === undefined) return;
    const message = scrub(text);
    const key = `${code}\n${message}`;
    if (state.sent.has(key) || state.events >= MAX_EVENTS) return;
    state.sent.add(key);
    state.events += 1;
    sending = true;
    try {
      send(
        JSON.stringify({
          backend: capped(globalString("__TN_ENGINE__") ?? "unknown", MAX_BACKEND),
          code,
          engine: CORE_VERSION,
          game: capped(globalString("__TN_GAME__") ?? "unknown", MAX_NAME),
          level,
          message,
          mode: globalValue("__TN_BUILD_ID__") === undefined ? "dev" : "prod",
          platform,
          session: state.session,
        }),
      );
    } catch {
      // Telemetry must never break a game: a body that will not serialise is simply not sent.
    } finally {
      sending = false;
    }
  };
  try {
    state.listeners = listen(record);
  } catch {
    // A global that refuses a listener still reports what the console carries.
  }
  console.warn = wrap(state.console.warn, "warn", record);
  console.error = wrap(state.console.error, "error", record);
  installed = state;
  console.info("TN_TELEMETRY on");
}

/** Stops reporting, putting back the exact `console.warn` / `console.error` install replaced. */
export function uninstallTelemetry(): void {
  if (installed === undefined) return;
  const scope = globalThis as unknown as Partial<IListenable>;
  for (const [type, listener] of installed.listeners) scope.removeEventListener?.(type, listener);
  console.warn = installed.console.warn;
  console.error = installed.console.error;
  installed = undefined;
}

/** The seam that turned this launch off, or undefined when none did. */
function offReason(options: ITelemetryOptions | undefined): string | undefined {
  if (options?.enabled === false) return "config";
  for (const [override, spec, askedFor] of OVERRIDES) {
    if (readLaunchFlag(spec, askedFor)) return override;
  }
  return undefined;
}

/**
 * Whether a playtest runner announced itself (the same two globals `playtest.ts` `runnerAnnounced`
 * reads, inlined because that module pulls the playtest bridge into every game). A scripted run
 * stays off by default: it is not a player, and on the native host a refused POST lands in
 * `fetch.network()` and fails a scenario's `noNetworkErrors` (`runtime-scripts/fetch-polyfill.js`).
 */
function playtestRunner(): boolean {
  const host = globalThis as Record<string, unknown>;
  return (
    host.__THREENATIVE_PLAYTEST_RUNNER_EXPECTED__ === true ||
    host.TN_PLAYTEST_ENDPOINT !== undefined
  );
}

/**
 * `web` for a browser page and the host's own OS name for the native runtime (desktop, Android,
 * iOS), or undefined where no game runs at all: a plain Node process has nobody to report to.
 *
 * The native answer is `getPlatform()`'s: core reads the host's `__THREENATIVE_NATIVE__` marker, so
 * `runtime` and `os` are already the host's words. A malformed marker throws there, which means a
 * broken host reports nothing rather than failing its boot.
 */
function telemetryPlatform(): string | undefined {
  try {
    const platform = getPlatform();
    if (platform.runtime === "native") return platform.os;
  } catch {
    return undefined;
  }
  const protocol = globalThis.location?.protocol;
  return protocol === "http:" || protocol === "https:" ? "web" : undefined;
}

/**
 * `console.warn` / `console.error`, calling the original with the original arguments every time.
 *
 * A marker argument is reported first, so the event describes the call rather than whatever the
 * console method or the transport does afterwards; anything thrown while reporting is swallowed.
 */
function wrap(original: ConsoleMethod, level: Level, record: Report): ConsoleMethod {
  return (...args: unknown[]) => {
    try {
      const text = textOf(args);
      if (text !== undefined) record(level, text);
    } catch {
      // Reporting is a side channel: the game's own log line still goes where it always went.
    }
    original.apply(console, args);
  };
}

/** The text a console call carries: its string arguments and any `Error`'s message, in order. */
function textOf(args: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const arg of args) {
    if (typeof arg === "string") parts.push(arg);
    else if (arg instanceof Error) parts.push(arg.message);
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** The `error` and `unhandledrejection` listeners, for a host whose global is an event target. */
function listen(record: Report): Array<readonly [type: string, listener: Listener]> {
  const scope = globalThis as unknown as Partial<IListenable>;
  if (
    typeof scope.addEventListener !== "function" ||
    typeof scope.removeEventListener !== "function"
  )
    return [];
  const pairs: Array<readonly [type: string, listener: Listener]> = [];
  const listenFor = (type: string, pick: (event: unknown) => string): void => {
    const listener: Listener = (event) => record("error", pick(event));
    scope.addEventListener?.(type, listener);
    pairs.push([type, listener]);
  };
  listenFor("error", errorMessage);
  listenFor("unhandledrejection", (event) =>
    reasonOf((event as { reason?: unknown } | undefined)?.reason),
  );
  return pairs;
}

/** A thrown error's message, or the event's own `message` when the host carried no error object. */
function errorMessage(event: unknown): string {
  const detail = event as { error?: unknown; message?: unknown } | undefined;
  const message = (detail?.error as { message?: unknown } | undefined)?.message;
  if (typeof message === "string") return message;
  return typeof detail?.message === "string" ? detail.message : "";
}

/** An unhandled rejection's reason: its message when it has one, else the value spelled out. */
function reasonOf(reason: unknown): string {
  const message = (reason as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : String(reason);
}

/**
 * The message as it may leave the machine: URLs, emails and absolute paths named by shape, long
 * digit runs dropped, and the rest cut at 200 characters.
 *
 * Scrubbed by pattern rather than by allow-list, because the point is that a hostile or careless
 * message cannot smuggle a page URL or a build path into the analytics table; the code and the
 * marker text are what the report is for.
 */
function scrub(text: string): string {
  const scrubbed = text
    .replace(/\b\w+:\/\/\S+/gu, "<url>")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/gu, "<email>")
    .replace(/[A-Za-z]:\\[^\s"'`]+/gu, "<path>")
    .replace(/(?:\/[\w.@+-]+){2,}/gu, "<path>")
    .replace(/\d{5,}/gu, "<n>");
  return capped(scrubbed, MAX_MESSAGE);
}

function capped(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function globalValue(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name];
}

/** A page global the build writes for this harness, when it is a non-empty string. */
function globalString(name: string): string | undefined {
  const value = globalValue(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** One id per install, so a run's events group without identifying anything. */
function newSession(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    // Without dashes: 32 hex characters, the site's cap for every short field.
    if (typeof uuid === "string") return uuid.replaceAll("-", "");
  } catch {
    // No Web Crypto, or a host that refuses it: a random string groups the session just as well.
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * One POST, never awaited and never thrown. `sendBeacon` is preferred because it survives the page
 * unload a crash often triggers; a plain string body is sent as `text/plain`, which keeps the
 * request a CORS simple request with no preflight to fail.
 */
function send(body: string): void {
  const scope = (globalThis as { navigator?: { sendBeacon?: unknown } }).navigator;
  const beacon = scope?.sendBeacon;
  if (typeof beacon === "function") {
    beacon.call(scope, ENDPOINT, body);
    return;
  }
  void fetch(ENDPOINT, {
    body,
    headers: { "Content-Type": "text/plain" },
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);
}
