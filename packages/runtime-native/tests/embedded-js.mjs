import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * Shared harness for the behavioral tests of the runtime's JavaScript shims.
 * The host evals each script into the game's JS engine at startup; every global
 * those scripts install is part of the host surface TypeScript framework code
 * may rely on (see AGENTS.md, "The host surface is a contract"). PRD-207 moved
 * the sources out of `runtime.cpp` raw-string literals into
 * `src/runtime-scripts/*.js`, so these helpers read the shipped file and still
 * fail closed when runtime.cpp stops loading it.
 */

/** C++ block name -> the runtime script that now carries that source. */
const SCRIPT_FOR_BLOCK = {
  createElementSetup: "create-element-setup",
  eventConstructorsSetup: "event-constructors-setup",
  fetchPolyfill: "fetch-polyfill",
  imageSupportInit: "image-support-init",
  storagePolyfill: "storage-polyfill",
  streamsPolyfill: "streams-polyfill",
  urlPolyfill: "url-worker-polyfill",
};

export function readRuntimeCpp() {
  return readFileSync(
    fileURLToPath(new URL("../src/runtime.cpp", import.meta.url)),
    "utf8",
  );
}

/**
 * Reads one shim's source by its historical C++ block name.
 *
 * `source` is runtime.cpp: the script only ships if the host still evals it, so
 * a shim that was renamed or dropped from the bootstrap fails here rather than
 * leaving the owning tests silently covering nothing.
 */
export function extractEmbeddedJs(source, blockName) {
  const script = SCRIPT_FOR_BLOCK[blockName];
  if (!script) {
    throw new Error(
      `no runtime script is mapped to the shim "${blockName}" — ` +
        "add it to SCRIPT_FOR_BLOCK or update the owning tests",
    );
  }
  if (!source.includes(`evalRuntimeScript(*jsEngine_, runtime_scripts::Script::${script.replaceAll("-", "_")}`)) {
    throw new Error(
      `runtime.cpp no longer loads the runtime script "${script}" — ` +
        "the shim was renamed or removed; update the owning tests",
    );
  }
  return readFileSync(
    fileURLToPath(new URL(`../src/runtime-scripts/${script}.js`, import.meta.url)),
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
