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

const LOG_FLAG = "TN_LOG";
const BROWSER_PROTOCOLS = new Set(["http:", "https:", "file:"]);

type ConsoleMethod = (...args: unknown[]) => void;
let restore: { log: ConsoleMethod; info: ConsoleMethod } | undefined;

/** Whether `TN_LOG` asks for markers at their own console level on this launch. */
export function markerLogRequested(): boolean {
  return readLaunchFlag({ environment: LOG_FLAG, global: "__THREENATIVE_LOG__", query: "tnLog" });
}

/** Re-routes `TN_` log/info lines to `console.debug`; a second call is a no-op. */
export function installQuietMarkers(): void {
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
  if (restore === undefined) return;
  console.log = restore.log;
  console.info = restore.info;
  restore = undefined;
}
