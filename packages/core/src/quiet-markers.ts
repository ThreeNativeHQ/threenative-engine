/**
 * Keeps the browser console quiet: a `console.log` / `console.info` line whose first argument
 * starts with `TN_` goes to `console.debug` instead, which DevTools hides at its default level and
 * Playwright still receives. `warn`, `error` and every other line are untouched.
 *
 * The flag that prints markers at their own level has the same three seams as `spansRequested()`:
 * `TN_LOG` through `process.env`, `?tnLog=1` in the page URL, and `globalThis.__THREENATIVE_LOG__`
 * (the worker host forwards `__THREENATIVE_` page globals, so a worker game follows the page).
 * Only a real browser page installs it: the native host stubs `document.location` but sets no
 * `globalThis.location`, so a native game keeps its console as the host prints it.
 */
import { readLaunchFlag } from "./debug.js";
import { isDevLaunch } from "./game-dev-tools.js";

const LOG_FLAG = "TN_LOG";
const BROWSER_PROTOCOLS = new Set(["http:", "https:", "file:"]);

type ConsoleMethod = (...args: unknown[]) => void;
let restore: { log: ConsoleMethod; info: ConsoleMethod } | undefined;

/**
 * The channel a worker game's `TN_` lines reach the page on in `pnpm dev` (PRD-923). The page's
 * dev shell keeps them for the Dev Dashboard's Performance & Health view, because a page cannot
 * read a worker's console. Production builds and the page itself never open it.
 */
export const DEV_MARKER_CHANNEL = "threenative-dev-markers";
const RELAYED = ["log", "info", "debug", "warn", "error"] as const;
let relay: { channel: BroadcastChannel; methods: Record<string, ConsoleMethod> } | undefined;

const inWorker = () =>
  typeof (globalThis as { importScripts?: unknown }).importScripts === "function" &&
  typeof (globalThis as { document?: unknown }).document === "undefined";

// ponytail: every open dev tab of the same origin hears every worker's lines; tag them per page if
// two games side by side ever need separate dashboards.
function relayWorkerMarkers(): void {
  if (
    relay !== undefined ||
    !inWorker() ||
    typeof BroadcastChannel !== "function" ||
    !isDevLaunch()
  )
    return;
  const channel = new BroadcastChannel(DEV_MARKER_CHANNEL);
  const methods: Record<string, ConsoleMethod> = {};
  for (const level of RELAYED) {
    const method = console[level] as ConsoleMethod;
    methods[level] = method;
    console[level] = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && first.startsWith("TN_"))
        channel.postMessage({ level, text: first.length > 8000 ? first.slice(0, 8000) : first });
      method.apply(console, args);
    };
  }
  relay = { channel, methods };
}

/** Whether `TN_LOG` asks for markers at their own console level on this launch. */
export function markerLogRequested(): boolean {
  return readLaunchFlag({ environment: LOG_FLAG, global: "__THREENATIVE_LOG__", query: "tnLog" });
}

/** Re-routes `TN_` log/info lines to `console.debug`; a second call is a no-op. */
export function installQuietMarkers(): void {
  relayWorkerMarkers();
  const protocol = globalThis.location?.protocol;
  if (restore !== undefined || typeof protocol !== "string" || !BROWSER_PROTOCOLS.has(protocol))
    return;
  if (markerLogRequested()) return;
  const original = { log: console.log, info: console.info };
  const quiet =
    (method: ConsoleMethod): ConsoleMethod =>
    (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("TN_")) console.debug(...args);
      else method.apply(console, args);
    };
  console.log = quiet(original.log);
  console.info = quiet(original.info);
  restore = original;
}

/** Puts back the exact console methods `installQuietMarkers` replaced. */
export function uninstallQuietMarkers(): void {
  // Reverse order of install: the quiet wrappers sit on top of the relay's.
  if (restore !== undefined) {
    console.log = restore.log;
    console.info = restore.info;
    restore = undefined;
  }
  if (relay === undefined) return;
  for (const level of RELAYED) console[level] = relay.methods[level] as ConsoleMethod;
  relay.channel.close();
  relay = undefined;
}
