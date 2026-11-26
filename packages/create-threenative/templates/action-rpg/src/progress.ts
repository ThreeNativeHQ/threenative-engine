import { createBackend } from "@threenative/backend";

/** The player's one save. `@threenative/backend` keeps it under this key locally and on the host. */
const SAVE_KEY = "threenative.action-rpg.progress";

interface IReadableStore<T> {
  getState(): T;
}

/** One client for the page: it owns the local cache, so nothing here touches localStorage. */
const backend = createBackend();

/** The last copy this page read or wrote, so the synchronous read has an answer before any await. */
let known: Record<string, unknown> | undefined;

function progressOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The local cache, synchronously: what `hydrateProgress` read, or the caller's initial state. */
export function loadProgress<T extends Record<string, unknown>>(initial: T): T {
  return { ...initial, ...(known ?? {}) };
}

/**
 * The save this device last knew, one await deep: the local cache answers at once and the host
 * fills it in when it is reachable, so a cleared `localStorage` still finds the hosted progress.
 * A player from before the backend kept the save under the same raw key, which is read once when
 * the backend has nothing and written through; it is left in place, because it is the only copy
 * when that write cannot land.
 */
export async function hydrateProgress<T extends Record<string, unknown>>(initial: T): Promise<T> {
  const hosted = progressOf(await backend.db.get(SAVE_KEY).catch(() => undefined));
  const legacy = hosted === undefined ? progressOf(readLegacy()) : undefined;
  if (legacy !== undefined) await backend.db.set(SAVE_KEY, legacy).catch(() => undefined);
  known = hosted ?? legacy;
  return loadProgress(initial);
}

function readLegacy(): unknown {
  try {
    // The only raw read left: a save written before `@threenative/backend` owned the local cache.
    return JSON.parse(globalThis.localStorage.getItem(SAVE_KEY) ?? "null");
  } catch {
    return undefined;
  }
}

/** ctx.state is the core createGameStore instance; this kit only serialises its JSON projection. */
export function saveProgress<T extends Record<string, unknown>>(store: IReadableStore<T>): void {
  // One snapshot per save: the upload may still be in flight while the next frame mutates state.
  known = { ...store.getState() };
  // Fire and forget: the write lands in the local cache before the upload, and a save must never
  // stop the game. ponytail: a version conflict settles on the host's copy, so two open tabs keep
  // the later tab's host copy; merge on `BackendError.value` when saves must reconcile.
  void backend.db.set(SAVE_KEY, known).catch(() => undefined);
}
