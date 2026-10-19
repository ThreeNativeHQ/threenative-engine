const SAVE_KEY = "threenative.action-rpg.progress";

interface IReadableStore<T> {
  getState(): T;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadProgress<T extends Record<string, unknown>>(initial: T): T {
  const raw = storage()?.getItem(SAVE_KEY);
  if (raw === null || raw === undefined) return { ...initial };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ...initial };
    return { ...initial, ...(parsed as Partial<T>) };
  } catch {
    return { ...initial };
  }
}

/** ctx.state is the core createGameStore instance; this kit only serialises its JSON projection. */
export function saveProgress<T extends Record<string, unknown>>(store: IReadableStore<T>): void {
  storage()?.setItem(SAVE_KEY, JSON.stringify(store.getState()));
}
