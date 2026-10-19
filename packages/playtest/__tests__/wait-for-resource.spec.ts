import { expect, test, vi } from "vitest";
import type { Page } from "playwright";

import type { IPlaytestObservationSnapshot } from "../src/index.js";
import { waitForResource } from "../src/runner/wait-for-resource.js";
import { runStep } from "../src/runner/steps.js";
import type { IPlaytestBridgeClient } from "../src/runner/bridgeClient.js";

test.each([false, true])("resource polling preserves the selected liveClock=%s", async (liveClock) => {
  vi.useFakeTimers();
  const advance = vi.fn(async () => undefined);
  let samples = 0;
  const bridge = {
    advance,
    description: { capabilities: ["runtime.fixedStep"] },
    sample: async () => snapshot(++samples >= 2),
  } as unknown as IPlaytestBridgeClient;
  try {
    const pending = runStep({} as Page, bridge,
      {timeoutMs: 100, waitForResource: {id: "state", path: "networkConnected", equals: true}, release: true},
      {width: 1280, height: 720}, undefined, [], {heldKeys: new Set(), pointerButtons: 0, pointers: new Map()},
      {include: ["resources"]}, true, undefined, liveClock);
    await vi.advanceTimersByTimeAsync(16);
    expect((await pending).afterStep?.resources?.state).toEqual({networkConnected: true});
    expect(advance).toHaveBeenCalledTimes(liveClock ? 0 : 1);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * `now` and `sleep` are injectable, so elapsed time is exact here rather than raced. A clock
 * that only moves when the wait samples is enough to place an observation on either side of
 * the deadline.
 */
function clock(): { advance: (ms: number) => void; now: () => number } {
  let current = 0;
  return { advance: (ms) => { current += ms; }, now: () => current };
}

function snapshot(connected: boolean): IPlaytestObservationSnapshot {
  return { clock: { now: 0 }, resources: { state: { networkConnected: connected } } } as unknown as IPlaytestObservationSnapshot;
}

test("a resource that satisfies the predicate within its budget passes", async () => {
  const time = clock();
  let samples = 0;
  const result = await waitForResource({
    id: "state",
    now: time.now,
    path: "networkConnected",
    predicate: { equals: true },
    sample: async () => {
      samples += 1;
      // Ready on the second sample, 16 ms in, comfortably inside the 100 ms budget.
      time.advance(16);
      return snapshot(samples >= 2);
    },
    sleep: async () => undefined,
    timeoutMs: 100,
  });

  expect(result).toEqual(snapshot(true));
  expect(samples).toBe(2);
});

test("an observation landing exactly on the budget still passes", async () => {
  // The boundary the deadline check turns on. Without this, tightening `remainingMs >= 0` to
  // `> 0` would reject a transition that met its budget exactly and no test would notice.
  const time = clock();
  const result = await waitForResource({
    id: "state",
    now: time.now,
    path: "networkConnected",
    predicate: { equals: true },
    sample: async () => {
      time.advance(32);
      return snapshot(true);
    },
    sleep: async () => undefined,
    timeoutMs: 32,
  });

  expect(result).toEqual(snapshot(true));
});

test("minimal polls gate a single full witness returned with its observations intact", async () => {
  const time = clock();
  let polls = 0;
  let witnesses = 0;
  const result = await waitForResource({
    id: "state",
    now: time.now,
    path: "networkConnected",
    predicate: { equals: true },
    poll: async () => {
      polls += 1;
      time.advance(16);
      return snapshot(polls >= 3);
    },
    sample: async () => {
      witnesses += 1;
      time.advance(1);
      return {
        clock: { now: 0 },
        entities: [{ id: "player", transform: { position: [1, 0, 0] } }],
        geometry: { measurements: [] },
        resources: { state: { networkConnected: true } },
      } as unknown as IPlaytestObservationSnapshot;
    },
    sleep: async () => undefined,
    timeoutMs: 100,
  });

  expect(polls).toBe(3);
  expect(witnesses).toBe(1);
  expect(result.entities).toEqual([{ id: "player", transform: { position: [1, 0, 0] } }]);
  expect(result.geometry).toEqual({ measurements: [] });
  expect(result.resources?.state).toEqual({ networkConnected: true });
});

test("a full witness arriving after the budget fails instead of blessing a passing poll", async () => {
  const time = clock();
  await expect(
    waitForResource({
      id: "state",
      now: time.now,
      path: "networkConnected",
      predicate: { equals: true },
      poll: async () => {
        time.advance(16);
        return snapshot(true);
      },
      sample: async () => {
        time.advance(100);
        return snapshot(true);
      },
      sleep: async () => undefined,
      timeoutMs: 32,
    }),
  ).rejects.toThrow(/timed out/iu);
});

test("a full witness that no longer passes resumes minimal polls", async () => {
  const time = clock();
  let polls = 0;
  let witnesses = 0;
  const result = await waitForResource({
    id: "state",
    now: time.now,
    path: "networkConnected",
    predicate: { equals: true },
    poll: async () => {
      polls += 1;
      time.advance(5);
      return snapshot(true);
    },
    sample: async () => {
      witnesses += 1;
      time.advance(5);
      return snapshot(witnesses >= 2);
    },
    sleep: async () => undefined,
    timeoutMs: 100,
  });

  expect(polls).toBe(2);
  expect(witnesses).toBe(2);
  expect(result).toEqual(snapshot(true));
});

test("a full witness that disappears on the deadline fails", async () => {
  const time = clock();
  await expect(
    waitForResource({
      id: "state",
      now: time.now,
      path: "networkConnected",
      predicate: { equals: true },
      poll: async () => {
        time.advance(16);
        return snapshot(true);
      },
      sample: async () => {
        time.advance(16);
        return snapshot(false);
      },
      sleep: async () => undefined,
      timeoutMs: 32,
    }),
  ).rejects.toThrow(/timed out/iu);
});

test("a full witness missing the waited resource fails closed", async () => {
  const time = clock();
  await expect(
    waitForResource({
      id: "state",
      now: time.now,
      path: "networkConnected",
      predicate: { equals: true },
      poll: async () => {
        time.advance(5);
        return snapshot(true);
      },
      sample: async () => ({
        clock: { now: 0 },
        resources: {},
      }) as unknown as IPlaytestObservationSnapshot,
      sleep: async () => undefined,
      timeoutMs: 100,
    }),
  ).rejects.toThrow(/did not report 'state'/u);
});

test("a resource that only becomes true after its timeout is a timeout, not a pass", async () => {
  // The wait returned as soon as the predicate held, before comparing elapsed time to the
  // budget, so an observation that arrived late still passed. A scenario asking for a
  // transition "within 32 ms" was satisfied by one that took 100.
  const time = clock();
  await expect(
    waitForResource({
      id: "state",
      now: time.now,
      path: "networkConnected",
      predicate: { equals: true },
      // The observation satisfies the predicate, but only after 100 ms have elapsed against
      // a 32 ms budget. Accepting it is the false green.
      sample: async () => {
        time.advance(100);
        return snapshot(true);
      },
      sleep: async () => undefined,
      timeoutMs: 32,
    }),
  ).rejects.toThrow(/timed out/iu);
});
