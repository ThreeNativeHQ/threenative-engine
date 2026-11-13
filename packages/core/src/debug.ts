/**
 * A debug switch a game reads the same way on every platform it ships to.
 *
 * Two questions an agent answers differently in every game, both of which cost a rewrite: how do I
 * turn this on for one run without changing the code, and how does a capture script reach the object
 * it wants to look at. The answers here are one function each, neither decides how anything looks.
 */

import { devGlobal, publishDevGlobal } from "./dev-global.js";

/** `freeCam` → `FREE_CAM`. A name a developer typed becomes a name a shell can set. */
function envName(name: string): string {
  return `TN_DEBUG_${name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase()}`;
}

/**
 * The three seams a launch has, named once. A native host sets the environment variable, a browser
 * page asks with the query parameter, and a test or capture harness sets the global before boot.
 */
export interface ILaunchFlagSpec {
  /** Environment variable a native host sets, e.g. `TN_TERRAIN_VALIDATE`. */
  readonly environment: string;
  /** Query parameter a browser asks with, e.g. `tnTerrainValidate`. */
  readonly query: string;
  /** Global a test or harness sets before the game boots, e.g. `__tnTerrainValidate`. */
  readonly global?: string;
}

/**
 * Every seam that named `flag`, in the order they are read: environment, query string, global.
 *
 * An empty environment variable is skipped — a shell that exports a name with no value did not ask
 * for anything — while an empty value on any other seam means the seam named the flag and had no
 * value to give, which is a URL's way of saying yes.
 */
function readLaunchSeams(spec: ILaunchFlagSpec, search?: string): readonly string[] {
  const values: string[] = [];
  if (spec.environment.length > 0) {
    const env = envValue(spec.environment);
    if (env !== undefined && env !== "") values.push(env);
  }
  const query = search ?? globalThis.location?.search;
  if (typeof query === "string") {
    const fromQuery = new URLSearchParams(query).get(spec.query);
    if (fromQuery !== null) values.push(fromQuery);
  }
  if (spec.global !== undefined) {
    const fromGlobal: unknown = (globalThis as Record<string, unknown>)[spec.global];
    if (typeof fromGlobal === "string") values.push(fromGlobal);
    else if (typeof fromGlobal === "number") values.push(String(fromGlobal));
    else if (typeof fromGlobal === "boolean") values.push(fromGlobal ? "true" : "false");
  }
  return values;
}

/** `0` and `false` are the only two spellings of off; a named-but-empty value is on. */
function isOff(value: string): boolean {
  return value === "0" || value === "false";
}

/**
 * Whether this launch asked for a flag, on one rule for every subsystem.
 *
 * `askedFor` says which answer the caller cares about: an opt-in switch (`"on"`, the default) is off
 * when no seam asked for it, and an opt-out switch (`"off"`) is on unless some seam asked it off.
 * Every seam that names the flag is heard, so a global a test sets is not lost behind an environment
 * variable that happens to disagree; what changes from the sixteen hand-written readers this
 * replaces is the vocabulary, not the seams: `0` and `false` are off and everything else is on.
 *
 * `search` is the query string to read, for a caller that already read the URL once at setup.
 *
 * @situation read one of the engine's launch switches the same way every subsystem does
 * @example const validate = readLaunchFlag({ environment: "TN_TERRAIN_VALIDATE", query: "tnTerrainValidate" });
 * @constraint `0` and `false` are off; a named-but-empty value is on; an empty variable is unset
 */
export function readLaunchFlag(
  spec: ILaunchFlagSpec,
  askedFor: "on" | "off" = "on",
  search?: string,
): boolean {
  const values = readLaunchSeams(spec, search);
  return askedFor === "off"
    ? values.some((value) => isOff(value))
    : values.some((value) => !isOff(value));
}

/**
 * The text this launch gave a flag, or `undefined` when no seam named it.
 *
 * For switches whose value is not a yes or no — an occlusion mode, a numeric override — the caller
 * parses. An empty string means a seam named the flag with no value.
 *
 * @situation read a launch override whose value is not a boolean
 * @example const mode = readLaunchValue({ environment: "TN_OCCLUSION", query: "tnOcclusion" });
 */
export function readLaunchValue(spec: ILaunchFlagSpec): string | undefined {
  return readLaunchSeams(spec)[0];
}

/**
 * Every value this launch gave a flag, one per seam that named it, in the order they are read.
 *
 * For the switches whose answer is not a yes or a no — a tri-state, a table of spellings — the
 * caller classifies the whole set rather than only the first seam's answer.
 *
 * @situation classify every value a launch gave one switch
 */
export function readLaunchValues(spec: ILaunchFlagSpec): readonly string[] {
  return readLaunchSeams(spec);
}

/**
 * `process.env` on a host that installed one, narrowed rather than asserted exactly as
 * `isDevLaunch` does in `game.ts`: it exists on the native runtime and not in a browser bundle.
 */
function envValue(name: string): string | undefined {
  const scope: unknown = globalThis;
  if (typeof scope !== "object" || scope === null || !("process" in scope)) return undefined;
  const hostProcess: unknown = scope.process;
  if (typeof hostProcess !== "object" || hostProcess === null || !("env" in hostProcess))
    return undefined;
  const env: unknown = hostProcess.env;
  if (typeof env !== "object" || env === null) return undefined;
  const value: unknown = (env as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A debug switch read from the URL, or from the environment on a native launch.
 *
 * @situation read a debug toggle from the URL, an environment variable or a harness global
 *
 * A browser asks with the query string — `?freeCam`, or `?freeCam=0` to force it off — and a native
 * launch asks with `TN_DEBUG_FREE_CAM`, because a query string is not something a developer sets on
 * a command line. `0` and `false` are off, so a saved URL that used to enable a switch still says
 * "off" rather than quietly turning it back on.
 */
export function debugFlag(name: string): boolean {
  return readLaunchFlag({ environment: envName(name), query: name });
}

/**
 * The text this launch gave a debug switch, or `undefined` when no seam named it.
 *
 * `debugFlag`'s non-boolean sibling: the same naming rule — `?name` on the web, `TN_DEBUG_NAME` on
 * a native launch — for a switch whose value is a word rather than a yes or no, such as a quality
 * tier or a mode. An empty string means a seam named the switch and gave no value.
 *
 * @situation read a debug override whose value is not a boolean
 * @situation override a quality tier or a mode for one run without changing the code
 * @constraint a name in camelCase becomes UPPER_SNAKE: `debugValue("quality")` reads `?quality=` or `TN_DEBUG_QUALITY`
 * @example const tier = debugValue("quality");
 */
export function debugValue(name: string): string | undefined {
  return readLaunchValue({ environment: envName(name), query: name });
}

/**
 * Publish one game object for a capture script or the console, in development builds only.
 *
 * @situation expose a game object to a capture script or the console in dev builds
 *
 * Playtest reads `__THREENATIVE__` in a dev build and is silent in a production one, so a game that
 * publishes its player, its camera or a scene handle under `.debug` is reachable from the same
 * place a production build is not. Other keys on the shared object are left alone; the dev surfaces
 * the engine installs beside them keep working.
 */
export function exposeDebug(name: string, value: unknown): void {
  // Written out here rather than through a helper: the bundler must see the literal `import.meta`
  // access to strip the whole publish from a production build, and an indirection survives into the
  // bundle — where the game is compiled as a script, not a module, and the bundle fails to parse.
  const isDev =
    (import.meta as ImportMeta & { env?: Record<"DEV", boolean | undefined> }).env?.DEV === true;
  if (!isDev) return;
  const tools = devGlobal(globalThis) ?? {};
  const debug = (tools.debug as Record<string, unknown> | undefined) ?? {};
  debug[name] = value;
  publishDevGlobal("debug", debug, globalThis);
}
