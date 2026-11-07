/**
 * The one owner of `__THREENATIVE__`, the object every dev surface publishes under.
 *
 * Five places used to spell the key itself — the debug flag, hot reload, the game's dev tools, the
 * UI overlay and the engine's export — so the global's name and its shape were written twice at
 * least. The worker keeps its own mirror list: that list is a typed tuple its mirror machinery is
 * built from, and moving it here changed what the worker host forwarded.
 *
 * Nothing here decides how anything looks: it is the seam a capture script, the console and the dev
 * overlay reach the running game through.
 */

/** The property name a dev surface publishes under, on the window and on a worker's global. */
export const DEV_GLOBAL_KEY = "__THREENATIVE__";

/** What the game's own dev tools publish: a snapshot, and an armed geometry capture. */
export interface IDevTools {
  snapshot(): import("./entities.js").EntitySnapshot;
  /**
   * Arms one per-object geometry capture for a development overlay. Absent until the game has a
   * render loop; the overlay treats that as "not ready", never as an empty scene.
   */
  geometry?(
    request?: import("./geometry-capture.js").IGeometryCaptureRequest,
  ): Promise<import("./geometry-capture.js").IGeometryCaptureReport>;
}

/** What a dev surface may publish under {@link DEV_GLOBAL_KEY}. */
export type DevGlobal = Partial<IDevTools> & Record<string, unknown>;

/**
 * The global a host installed, or `undefined` outside a dev launch.
 *
 * `scope` is required on purpose: a default of `globalThis` would make an explicit `undefined` read
 * the page's global, which is exactly the worker case a caller is asking about.
 */
export function devGlobal(scope: unknown): DevGlobal | undefined {
  const value = (scope as Record<string, unknown> | undefined)?.[DEV_GLOBAL_KEY];
  return typeof value === "object" && value !== null ? (value as DevGlobal) : undefined;
}

/** Adds one member to the global, keeping whatever another surface already published. */
export function publishDevGlobal(name: string, value: unknown, scope: unknown): void {
  const host = scope as Record<string, unknown> | undefined;
  if (host === undefined) return;
  // In place: a surface that published earlier keeps its identity, which is what lets a disposer
  // check `devGlobal(host) === mine` and leave another surface's members alone.
  const current = devGlobal(scope);
  if (current !== undefined) {
    current[name] = value;
    return;
  }
  host[DEV_GLOBAL_KEY] = { [name]: value };
}
