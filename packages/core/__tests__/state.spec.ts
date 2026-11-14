import { describe, expect, it, vi } from "vitest";
import { createGameStore } from "../src/state.js";

describe("createGameStore", () => {
  it("should publish nothing on a timer when no interval was named, and one frame of writes once", () => {
    vi.useFakeTimers();
    const store = createGameStore({ score: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.start();

    for (let score = 0; score < 600; score++) store.set({ score });
    vi.advanceTimersByTime(1_000);
    expect(notifications).toBe(0);

    // The frame is the publisher, so the whole second of writes lands as one notification.
    store.flush();
    expect(notifications).toBe(1);
    expect(store.getState().score).toBe(599);
    unsubscribe();
    store.stop();
    vi.useRealTimers();
  });

  it("should notify at most 11 times when a game asks for the 100 ms interval", () => {
    vi.useFakeTimers();
    const store = createGameStore({ score: 0 }, 100);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.start();

    for (let score = 0; score < 600; score++) store.set({ score });
    vi.advanceTimersByTime(1_000);

    expect(notifications).toBeLessThanOrEqual(11);
    expect(store.getState().score).toBe(599);
    unsubscribe();
    store.stop();
    vi.useRealTimers();
  });

  it("should deliver the latest value, not an intermediate one", () => {
    const store = createGameStore({ score: 0 });
    const observed: number[] = [];
    const unsubscribe = store.subscribe((state) => observed.push(state.score));

    store.set({ score: 1 });
    store.set({ score: 599 });
    store.flush();

    expect(observed).toEqual([599]);
    unsubscribe();
    store.stop();
  });

  it("should expose coalesced writes to gameplay before notifying subscribers", () => {
    const store = createGameStore({ score: 0 });
    const observed: number[] = [];
    const unsubscribe = store.subscribe((state) => observed.push(state.score));

    store.set({ score: 1 });
    store.set((state) => ({ score: state.score + 1 }));

    expect(store.getState().score).toBe(2);
    expect(observed).toEqual([]);
    store.flush();
    expect(observed).toEqual([2]);
    unsubscribe();
    store.stop();
  });

  it("should keep the immediate snapshot identity stable across pre-flush writes", () => {
    const store = createGameStore({ score: 0 });
    const immediate = store.getState();

    for (let score = 1; score <= 600; score += 1) store.set({ score });

    expect(store.getState()).toBe(immediate);
    expect(store.getState().score).toBe(600);
    store.stop();
  });

  it("should never mutate a retained published snapshot", () => {
    const store = createGameStore({ score: 0 });
    const published: Readonly<{ score: number }>[] = [];
    const unsubscribe = store.subscribe((state) => published.push(state));

    store.set({ score: 1 });
    store.flush();
    store.set({ score: 2 });
    store.flush();

    expect(published).toHaveLength(2);
    expect(published[0]).toEqual({ score: 1 });
    expect(published[1]).toEqual({ score: 2 });
    expect(published[0]).not.toBe(published[1]);
    unsubscribe();
    store.stop();
  });
});

describe("createGameStore changed-only publication", () => {
  it("should publish nothing when every value put back is the one already published", () => {
    const store = createGameStore({ credits: 40, score: 7 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);

    for (let frame = 0; frame < 600; frame++) {
      store.set({ credits: 40, score: 7 });
      store.flush();
    }

    expect(notifications).toBe(0);
    unsubscribe();
    store.stop();
  });

  it("should publish the one changed key and keep the unchanged siblings quiet", () => {
    const store = createGameStore({ credits: 40, score: 7 });
    const observed: Array<{ credits: number; score: number }> = [];
    const unsubscribe = store.subscribe((state) => observed.push({ ...state }));

    store.set({ credits: 40, score: 8 });
    store.flush();

    expect(observed).toEqual([{ credits: 40, score: 8 }]);
    unsubscribe();
    store.stop();
  });

  it("should publish nothing when the same object is mutated and set again", () => {
    const inventory = { count: 1 };
    const store = createGameStore<{ inventory: { count: number } }>({ inventory });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);

    inventory.count = 2;
    store.set({ inventory });
    store.flush();
    expect(notifications).toBe(0);

    store.set({ inventory: { count: 2 } });
    store.flush();
    expect(notifications).toBe(1);
    unsubscribe();
    store.stop();
  });
});
