import { type StoreApi, createStore } from "zustand/vanilla";

export type StatePatch<T extends Record<string, unknown>> = Partial<T> | ((state: T) => Partial<T>);

export type GameStore<T extends Record<string, unknown>> = StoreApi<T> & {
  getPublishedState(): T;
  set(patch: StatePatch<T>): void;
  flush(): void;
  start(): void;
  stop(): void;
};

/**
 * A store the UI reads, coalesced to one publication per frame unless a game names an interval.
 *
 * A key whose new value is `Object.is`-equal to the current value does not enter `pending`, so a
 * frame that changed nothing publishes nothing and `flush` stays quiet. The flip side: mutating an
 * object in place and setting it again is the same object, so nothing publishes — publish a new
 * object or bump a version field on the value.
 *
 * `intervalMs` is an override, not the rule. A fixed 100 ms default published the HUD ten times a
 * second whatever the frame rate was, which reads as a HUD that is not live — the number a player
 * watches moves in visible steps while the scene beside it runs smoothly. Left unset, `flush` is
 * called once per frame by the loop that draws that frame, so a HUD updates at the rate the game
 * actually runs at, and a slower interval is available to a game that measured a reason for one.
 */
export function createGameStore<T extends Record<string, unknown>>(
  initial: T,
  intervalMs?: number,
): GameStore<T> {
  const store = createStore<T>(() => ({ ...initial }));
  const getPublishedState = store.getState;
  const current = { ...initial };
  const pending: Partial<T> = {};
  let hasPending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  store.subscribe((state) => {
    for (const key in current) {
      if (!(key in state)) Reflect.deleteProperty(current, key);
    }
    Object.assign(current, state);
  });
  const flush = () => {
    if (!hasPending) return;
    hasPending = false;
    const patch = { ...pending };
    for (const key in pending) Reflect.deleteProperty(pending, key);
    store.setState(patch);
  };
  const gameStore = store as GameStore<T>;
  gameStore.getPublishedState = getPublishedState;
  gameStore.getState = () => current;
  gameStore.set = (patch: StatePatch<T>) => {
    const next = typeof patch === "function" ? patch(current) : patch;
    let changed = false;
    for (const key in next) {
      const value = next[key];
      // The value the HUD would publish is the one it already has: no publish, no cross-process
      // write on native. Five kits hand-wrote this comparison before every `set`.
      if (Object.is(value, current[key])) continue;
      Reflect.set(pending, key, value);
      Reflect.set(current, key, value);
      changed = true;
    }
    if (changed) hasPending = true;
  };
  gameStore.flush = flush;
  gameStore.start = () => {
    // No interval means the frame drives the flush; only a game that named one gets a timer.
    if (intervalMs === undefined || timer !== undefined) return;
    timer = setInterval(flush, intervalMs);
  };
  gameStore.stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    flush();
  };
  return gameStore;
}
