/// <reference path="./import-meta.d.ts" />

import { DEV_GLOBAL_KEY, type IDevTools, devGlobal } from "./dev-global.js";
import type { EntitySnapshot, Registry } from "./entities.js";
import type {
  GeometryCapture,
  IGeometryCaptureReport,
  IGeometryCaptureRequest,
} from "./geometry-capture.js";

export type DevToolsHost = Record<string, unknown> &
  Partial<Record<typeof DEV_GLOBAL_KEY, Partial<IDevTools>>>;

/**
 * The bundler's dev flag.
 *
 * The `import.meta.env` access must stay written out exactly here. Vite replaces that member
 * expression at build time; any indirection — a variable holding `import.meta`, or a helper that
 * takes it as an argument — survives into the bundle, where the game is compiled as a script and
 * not a module, and the whole bundle then fails to parse with "Cannot use 'import.meta' outside a
 * module". That is a game that never starts, so the literal access is load-bearing, not style.
 */
function bundlerDevFlag(): boolean {
  return (import.meta as IImportMeta).env?.DEV === true;
}

/**
 * Whether this launch is a development one.
 *
 * A web build answers through Vite's own flag. A native build has no bundler flag at launch, so the
 * host publishes `DEV_MODE` on `process.env` — the one place a game can read how it was started —
 * and this reads it. Both routes answer the same question: should the dev surfaces exist.
 */
export function isDevLaunch(): boolean {
  // `process.env` exists only where a host installed one: the native runtime does, a browser
  // bundle does not. Narrowed rather than asserted, so a host that installs something else
  // answers "not dev" instead of reading a field that is not there.
  const scope: unknown = globalThis;
  if (typeof scope === "object" && scope !== null && "process" in scope) {
    const hostProcess: unknown = scope.process;
    if (typeof hostProcess === "object" && hostProcess !== null && "env" in hostProcess) {
      const env: unknown = hostProcess.env;
      if (typeof env === "object" && env !== null && "DEV_MODE" in env) {
        const flag: unknown = env.DEV_MODE;
        if (typeof flag === "string" && flag !== "" && flag !== "0" && flag !== "false")
          return true;
      }
    }
  }
  return bundlerDevFlag();
}

export function installDevTools(
  entities: Registry,
  host: DevToolsHost | undefined,
  // Late-bound: the capture is constructed with the render loop, after this install runs.
  geometry: () => GeometryCapture | undefined,
): () => void {
  // Written out here, not through `isDevLaunch()`: the bundler must see the literal flag to strip
  // this whole install from a production build, and a runtime `DEV_MODE` check cannot be stripped.
  const isDev = (import.meta as IImportMeta).env?.DEV === true;
  if (!isDev || host === undefined) return () => undefined;
  const current = devGlobal(host) ?? {};
  const devTools: IDevTools = {
    ...(current as Partial<IDevTools>),
    geometry: async (request) => {
      const capture = geometry();
      if (capture === undefined) {
        return {
          reason: "TN_GEOMETRY_CAPTURE_NO_LOOP: the game has no running render loop to capture.",
          status: "unavailable",
        };
      }
      return capture.request(request);
    },
    snapshot: () => entities.snapshot(),
  };
  host[DEV_GLOBAL_KEY] = devTools;
  return () => {
    if (devGlobal(host) !== devTools) return;
    const remaining = Object.fromEntries(
      Object.entries(devTools).filter(([key]) => key !== "snapshot" && key !== "geometry"),
    );
    host[DEV_GLOBAL_KEY] = Object.keys(remaining).length === 0 ? undefined : remaining;
  };
}
