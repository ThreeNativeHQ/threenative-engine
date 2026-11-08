import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * Shared harness for the behavioral tests of the runtime's JavaScript shims.
 * The host evals each script into the game's JS engine at startup; every global
 * those scripts install is part of the host surface TypeScript framework code
 * may rely on (see AGENTS.md, "The host surface is a contract").
 */

/**
 * Reads one shipped runtime script, such as `fetch-polyfill`, from `src/runtime-scripts/`.
 *
 * Whether the host evaluates that script, and in which order, is proved by running the host:
 * `tests/shim_bootstrap_test.cpp` boots a headless `Runtime` and probes the globals the scripts
 * install. These helpers only load the JavaScript so a guest realm can exercise it.
 */
export function readRuntimeScript(name) {
  return readFileSync(
    fileURLToPath(new URL(`../src/runtime-scripts/${name}.js`, import.meta.url)),
    "utf8",
  );
}

/**
 * Deterministic stand-in for the host-provided timer globals. The native host
 * owns the event loop, so embedded shims never see Node's timers; draining a
 * manual queue keeps tests ordered and flake-free.
 */
export function createTimers() {
  const queue = [];
  let nextId = 1;
  return {
    setTimeout(fn) {
      queue.push({ id: nextId, fn });
      return nextId++;
    },
    clearTimeout(id) {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    /** Runs every pending callback, including callbacks those schedule, until quiet. */
    drain(maxTurns = 100) {
      for (let turn = 0; turn < maxTurns && queue.length > 0; turn += 1) {
        const batch = queue.splice(0, queue.length);
        for (const entry of batch) entry.fn();
      }
      return queue.length;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}

/** Records console output so tests can assert what the host would print. */
export function createRecordingConsole() {
  const lines = [];
  return {
    lines,
    log(...args) {
      lines.push(args.map(String).join(" "));
    },
    error: (...args) => lines.push(args.map(String).join(" ")),
    warn: (...args) => lines.push(args.map(String).join(" ")),
  };
}

/**
 * A bare guest context: standard built-ins only, none of Node's browser-shaped
 * globals — the same starting point QuickJS/V8 have before the host installs
 * its shims.
 */
export function createGuestContext(globals = {}) {
  return vm.createContext({ ...globals });
}

/**
 * Normalizes a value returned from the guest realm (its objects carry another
 * Object.prototype, which breaks Node's structural equality) into a plain host
 * value. Guest data must be JSON-safe for this to work — true for everything
 * these shims exchange with the host.
 */
export function guest(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}
