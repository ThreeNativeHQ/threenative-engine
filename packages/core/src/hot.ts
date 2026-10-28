/// <reference path="./import-meta.d.ts" />

import { audioRuntimeSnapshot } from "./audio.js";
import type { IGame } from "./game.js";
import { hostDocument, hostWindow } from "./platform.js";
export interface IHotDiagnostics {
  readonly reloads: number;
  readonly entities: number;
  readonly sceneObjects: number;
  readonly canvases: number;
  readonly audio: ReturnType<typeof audioRuntimeSnapshot>;
  readonly physics: number | null;
}
type HotData = {
  readonly state: Record<string, unknown>;
  readonly reloads: number;
  /** The scene the session was in. Absent for data written before scene resume existed. */
  readonly sceneName?: string | undefined;
  /** The session's startup had lifted its cover, so its HUD was showing. */
  readonly revealed?: boolean;
};
const isDev =
  (import.meta as ImportMeta & { env?: Record<"DEV", boolean | undefined> }).env?.DEV === true;
/**
 * Validate that hot-reload state can cross the Vite boundary.
 * @situation preserve JSON-shaped state during hot reload
 * @situation reject a non-portable game state before reload
 * @constraint state must contain finite numbers and plain objects only
 * @example assertPortableState(game.state.getState());
 */
export function assertPortableState(state: unknown): void {
  visitPortable(state, "state", new Set<object>());
}
/**
 * Register hot-reload state preservation for a game.
 * @situation keep game state while editing source in development
 * @situation diagnose state shape changes during hot reload
 * @constraint use only in the web development entry
 * @example acceptHotUpdate(game, import.meta.hot);
 */
export function acceptHotUpdate<TState extends Record<string, unknown>, TPhysics>(
  game: IGame<TState, TPhysics>,
  hot: IImportMeta["hot"],
): void {
  if (hot === undefined) return;
  hot.accept();
  const carried = hot.data.threenative as HotData | undefined;
  const reloads = carried?.reloads ?? 0;
  if (carried !== undefined) restoreState(game, carried.state);
  // State alone was never enough. The update re-runs the game's entry module, which rebuilds the
  // game and boots it at `config.start` — so a session that was playing came back holding its own
  // state on the main menu, with every entity and its physics world gone, and the store insisting
  // the screen was still "playing". Resuming the scene is what makes the restored state true.
  // Whether this session's HUD is showing: carried from a restart that kept it, else this
  // startup's own reveal. One save can update the module twice, the second before this startup
  // is ready, and that update must not cover a HUD the player is looking at.
  let revealed = false;
  if (carried?.sceneName !== undefined) {
    try {
      game.resumeScene(carried.sceneName, { revealed: carried.revealed === true });
      revealed = carried.revealed === true;
    } catch {
      // A scene that no longer exists in the updated module is not a reason to lose the reload;
      // the game boots at its start scene, which is what it would have done anyway.
    }
  }
  const page = hostWindow();
  if (isDev && page !== undefined) {
    const host = page as unknown as Record<string, unknown> &
      Partial<Record<"__THREENATIVE__", Record<string, unknown> & { hot?: () => IHotDiagnostics }>>;
    host.__THREENATIVE__ = {
      ...host.__THREENATIVE__,
      hot: () => diagnostics(game, reloads),
      snapshot: host.__THREENATIVE__?.snapshot ?? (() => ({})),
    };
  }
  let disposed = false;
  hot.dispose((data) => {
    if (disposed) return;
    disposed = true;
    try {
      game.state.flush();
      const state = game.state.getState();
      assertPortableState(state);
      data.threenative = {
        reloads: reloads + 1,
        revealed: revealed || game.ctx?.startup.phase === "ready",
        sceneName: game.sceneName,
        state,
      };
    } catch (error) {
      data.threenative = undefined;
      hot.invalidate(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      game.stop();
    }
  });
}
function restoreState<TState extends Record<string, unknown>, TPhysics>(
  game: IGame<TState, TPhysics>,
  carried: Record<string, unknown>,
): void {
  assertPortableState(carried);
  const defaults = game.state.getState();
  const state: Record<string, unknown> = { ...defaults };
  const dropped = Object.keys(carried).filter((key) => !(key in defaults));
  const added = Object.keys(defaults).filter((key) => !(key in carried));
  for (const key of Object.keys(defaults)) {
    if (key in carried) state[key] = carried[key];
  }
  game.state.setState(state as TState);
  if (dropped.length > 0 || added.length > 0)
    console.info(
      `ThreeNative hot reload state shape: dropped [${dropped.join(", ")}]; added [${added.join(", ")}]`,
    );
}
function diagnostics<TState extends Record<string, unknown>, TPhysics>(
  game: IGame<TState, TPhysics>,
  reloads: number,
): IHotDiagnostics {
  const ctx = game.ctx;
  let sceneObjects = 0;
  ctx?.scene.traverse(() => {
    sceneObjects += 1;
  });
  const physics = ctx?.physics as { numBodies?: unknown } | undefined;
  return {
    reloads,
    entities: ctx === undefined ? 0 : Object.keys(ctx.entities.snapshot()).length,
    sceneObjects,
    canvases: hostDocument()?.querySelectorAll("canvas").length ?? 0,
    audio: audioRuntimeSnapshot(),
    physics: typeof physics?.numBodies === "function" ? physics.numBodies() : null,
  };
}
function visitPortable(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value !== "object") {
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "number")
      throw new Error(`Hot reload state ${path} must contain only finite numbers.`);
    throw new Error(`Hot reload state ${path} must contain only JSON-shaped values.`);
  }
  if (ancestors.has(value)) throw new Error(`Hot reload state ${path} contains a cycle.`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1)
      visitPortable(value[index], `${path}[${index}]`, ancestors);
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`Hot reload state ${path} must contain only plain objects.`);
  ancestors.add(value);
  for (const key of Object.keys(value))
    visitPortable((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
  ancestors.delete(value);
}

interface IImportMeta {
  readonly env?: {
    readonly DEV?: boolean;
  };
  readonly hot?: IViteHotContext;
}

interface IViteHotContext {
  readonly data: Record<string, unknown>;
  accept(): void;
  dispose(callback: (data: Record<string, unknown>) => void): void;
  invalidate(message?: string): void;
}
