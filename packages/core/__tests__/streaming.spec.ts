import { describe, expect, test, vi } from "vitest";

import { addInSlices, loadAll } from "../src/streaming.js";

/**
 * Two load-time wins measured in a real game, promoted here so no game writes them again.
 *
 * `addInSlices` is the attach loop: a game that builds four hundred objects behind a loading
 * curtain and adds them all inside one frame gives a browser watchdog a hung page, and a game
 * that adds one per presented frame pays four hundred presents. Measured on the same build and
 * content against an 8 s budget: 1 per frame 16.5 s, 6 per frame 11.26 s, 24 per frame 9.39 s,
 * 256 per frame 6.89 s, all at once 7.18 s.
 *
 * `loadAll` is the fetch loop: 52 models loaded one at a time took 38.4 s, six at a time 8.8 s.
 * The trap that cost that game a nondeterministic world is the one asserted hardest here —
 * a worker pool that pushes results returns them in completion order, so whatever picks from the
 * list positionally gets a different answer on every load.
 */

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Index into a fixture array without a non-null assertion; a miss is a broken test, not a value. */
const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`Fixture has no entry at ${String(index)}.`);
  return value;
};

/** A yield the test drives by hand, so "a frame was presented" is an observation, not a timer. */
const countingYield = (): { calls: () => number; yieldFrame: () => Promise<void> } => {
  let calls = 0;
  return {
    calls: () => calls,
    yieldFrame: () => {
      calls += 1;
      return Promise.resolve();
    },
  };
};

/**
 * A clock the test drives by hand, so "this slice ran long" is an observation rather than a timer.
 *
 * `addInSlices` reads `globalThis.performance.now()` where it slices, which is the same call the
 * browser makes; replacing the reading is all it takes to put a 5 ms object in front of an 8 ms
 * budget without waiting 8 ms of wall clock to find out.
 */
const fakeClock = (): { advance: (ms: number) => void; restore: () => void } => {
  let ms = 0;
  const spy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => ms);
  return {
    advance: (by) => {
      ms += by;
    },
    restore: () => spy.mockRestore(),
  };
};

describe("addInSlices", () => {
  test("adds every object, in order, and reports what it did", async () => {
    const added: number[] = [];
    const report = await addInSlices([1, 2, 3, 4, 5], (value) => added.push(value), {
      marker: false,
      sliceSize: 2,
      yieldFrame: () => Promise.resolve(),
    });

    expect(added).toEqual([1, 2, 3, 4, 5]);
    expect(report.added).toBe(5);
    expect(report.total).toBe(5);
    expect(report.stopped).toBe(false);
    expect(report.sliceSize).toBe(2);
  });

  test("yields between slices, and not after the last one", async () => {
    const { calls, yieldFrame } = countingYield();
    // Six objects at two per slice is three slices, so two yields: the caller renders after the
    // final slice anyway, and a trailing yield would only add a frame to the load.
    const report = await addInSlices([1, 2, 3, 4, 5, 6], () => undefined, {
      marker: false,
      sliceSize: 2,
      yieldFrame,
    });

    expect(calls()).toBe(2);
    expect(report.slices).toBe(3);
  });

  test("a slice larger than the work still presents nothing mid-run", async () => {
    const { calls, yieldFrame } = countingYield();
    const report = await addInSlices([1, 2, 3], () => undefined, {
      marker: false,
      sliceSize: 256,
      yieldFrame,
    });

    expect(calls()).toBe(0);
    expect(report.slices).toBe(1);
    expect(report.added).toBe(3);
  });

  test("with no slice size the run is time-budgeted, and the report says so", async () => {
    const clock = fakeClock();
    try {
      const report = await addInSlices([1], () => undefined, {
        marker: false,
        yieldFrame: () => Promise.resolve(),
      });

      expect(report.sliceSizeOverridden).toBe(false);
      expect(report.sliceBudgetMs).toBe(8);
    } finally {
      clock.restore();
    }
  });

  test("a count of 256 is not paid for by objects that cost nothing", async () => {
    const clock = fakeClock();
    const { calls, yieldFrame } = countingYield();
    try {
      // A thousand cheap objects: the count-based default cut this into four presents, which is a
      // frame each for work that costs microseconds. Nothing here advances the clock, so the whole
      // run fits in one budget and the loop must present once, at the end.
      const report = await addInSlices(
        Array.from({ length: 1000 }, (_unused, index) => index),
        () => undefined,
        { marker: false, yieldFrame },
      );

      expect(report.added).toBe(1000);
      expect(report.slices).toBe(1);
      expect(calls()).toBe(0);
      // Measured, not assumed: one slice for a thousand objects is what a caller reads back.
      expect(report.sliceSize).toBe(1000);
    } finally {
      clock.restore();
    }
  });

  test("an expensive object cuts the slice at the budget rather than at a count", async () => {
    const clock = fakeClock();
    const { calls, yieldFrame } = countingYield();
    try {
      // 5 ms per object against an 8 ms budget: a slice is two objects, so twelve objects are six
      // slices and five presents — the last object still ends the run without a sixth.
      const report = await addInSlices(
        Array.from({ length: 12 }, (_unused, index) => index),
        () => clock.advance(5),
        { marker: false, yieldFrame },
      );

      expect(report.slices).toBe(6);
      expect(calls()).toBe(5);
      expect(report.sliceSize).toBe(2);
    } finally {
      clock.restore();
    }
  });

  test("a slice size the game gave stays a count, even when the objects are expensive", async () => {
    const clock = fakeClock();
    const { calls, yieldFrame } = countingYield();
    try {
      // Three objects at 5 ms each is 15 ms, well past the budget: if the time mode leaked in, the
      // slices would be six of two objects instead of four of three.
      const report = await addInSlices(
        Array.from({ length: 12 }, (_unused, index) => index),
        () => clock.advance(5),
        { marker: false, sliceSize: 3, yieldFrame },
      );

      expect(report.slices).toBe(4);
      expect(calls()).toBe(3);
      expect(report.sliceSize).toBe(3);
      expect(report.sliceBudgetMs).toBeUndefined();
    } finally {
      clock.restore();
    }
  });

  test("an overridden slice is reported as overridden", async () => {
    const report = await addInSlices([1], () => undefined, {
      marker: false,
      sliceSize: 4,
      yieldFrame: () => Promise.resolve(),
    });

    expect(report.sliceSize).toBe(4);
    expect(report.sliceSizeOverridden).toBe(true);
  });

  test("`while` stops the run between objects and reports the stop, without throwing", async () => {
    const added: number[] = [];
    let live = true;
    const report = await addInSlices(
      [1, 2, 3, 4, 5, 6],
      (value) => {
        added.push(value);
        if (value === 3) live = false;
      },
      { marker: false, sliceSize: 2, while: () => live, yieldFrame: () => Promise.resolve() },
    );

    expect(added).toEqual([1, 2, 3]);
    expect(report.added).toBe(3);
    expect(report.total).toBe(6);
    expect(report.stopped).toBe(true);
  });

  test("`while` false from the start adds nothing and still reports", async () => {
    const add = vi.fn();
    const report = await addInSlices([1, 2, 3], add, {
      marker: false,
      while: () => false,
      yieldFrame: () => Promise.resolve(),
    });

    expect(add).not.toHaveBeenCalled();
    expect(report.added).toBe(0);
    expect(report.stopped).toBe(true);
  });

  test("progress is reported per slice and never exceeds the total", async () => {
    const seen: number[] = [];
    await addInSlices([1, 2, 3, 4, 5], () => undefined, {
      marker: false,
      onProgress: (progress) => {
        expect(progress.total).toBe(5);
        expect(progress.added).toBeLessThanOrEqual(progress.total);
        seen.push(progress.added);
      },
      sliceSize: 2,
      yieldFrame: () => Promise.resolve(),
    });

    expect(seen).toEqual([2, 4, 5]);
  });

  test("an empty list is a real answer, not a reason to skip the report", async () => {
    const report = await addInSlices([], () => undefined, { marker: false });

    expect(report.added).toBe(0);
    expect(report.total).toBe(0);
    expect(report.slices).toBe(0);
    expect(report.stopped).toBe(false);
  });

  test("turning the marker off does not turn the measurement off", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const quiet = await addInSlices([1, 2], () => undefined, {
        marker: false,
        sliceSize: 1,
        yieldFrame: () => Promise.resolve(),
      });
      expect(info).not.toHaveBeenCalled();
      expect(quiet.slices).toBe(2);

      const loud = await addInSlices([1, 2], () => undefined, {
        sliceSize: 1,
        yieldFrame: () => Promise.resolve(),
      });
      expect(loud.slices).toBe(2);
      const line = info.mock.calls
        .map((call) => String(call[0]))
        .find((c) => c.includes("TN_ADD_SLICES"));
      expect(line).toBeDefined();
      // The marker names the slice actually used and whether the game chose it, so a load that is
      // slow for the wrong reason can be read off a log without a rebuild.
      expect(line).toContain("sliceSize=1");
      expect(line).toContain("overridden=true");
      expect(line).toContain("budgetMs=none");

      info.mockClear();
      await addInSlices([1], () => undefined, { yieldFrame: () => Promise.resolve() });
      const budgeted = info.mock.calls
        .map((call) => String(call[0]))
        .find((c) => c.includes("TN_ADD_SLICES"));
      expect(budgeted).toContain("budgetMs=8");
      expect(budgeted).toContain("overridden=false");
    } finally {
      info.mockRestore();
    }
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "fails closed on a nonsensical slice size (%s)",
    async (sliceSize) => {
      await expect(addInSlices([1], () => undefined, { marker: false, sliceSize })).rejects.toThrow(
        "TN_ADD_SLICES_SLICE_INVALID",
      );
    },
  );

  test("an add that throws rejects rather than swallowing the failure", async () => {
    await expect(
      addInSlices(
        [1, 2],
        () => {
          throw new Error("attach failed");
        },
        { marker: false },
      ),
    ).rejects.toThrow("attach failed");
  });
});

describe("loadAll", () => {
  test("returns results in input order however the loads complete", async () => {
    // Every load is held open and released in reverse, which is precisely the completion order a
    // pushing worker pool would hand back.
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const pending = loadAll(["a", "b", "c", "d"], (_item, index) => at(gates, index).promise, {
      concurrency: 4,
      marker: false,
      yieldFrame: () => Promise.resolve(),
    });
    at(gates, 3).resolve("d");
    at(gates, 1).resolve("b");
    at(gates, 2).resolve("c");
    at(gates, 0).resolve("a");

    await expect(pending).resolves.toEqual(["a", "b", "c", "d"]);
  });

  test("never runs more loads at once than the concurrency allows", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    const results = await loadAll(
      items,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return item * 2;
      },
      { concurrency: 3, marker: false, yieldFrame: () => Promise.resolve() },
    );

    expect(peak).toBe(3);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  test("actually overlaps: serial loading would deadlock this", async () => {
    // Three loads that each wait for the next to have started. Only a pool that runs them
    // concurrently can settle this; a serial loop hangs.
    const started = [deferred<void>(), deferred<void>(), deferred<void>()];
    const results = await loadAll(
      [0, 1, 2],
      async (item) => {
        at(started, item).resolve();
        await Promise.all(started.map((gate) => gate.promise));
        return item;
      },
      { concurrency: 3, marker: false, yieldFrame: () => Promise.resolve() },
    );

    expect(results).toEqual([0, 1, 2]);
  });

  test("the default concurrency is 6", async () => {
    let peak = 0;
    let inFlight = 0;
    await loadAll(
      Array.from({ length: 30 }, (_unused, index) => index),
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return item;
      },
      { marker: false, yieldFrame: () => Promise.resolve() },
    );

    expect(peak).toBe(6);
  });

  test("progress counts settled loads and reports the total up front", async () => {
    const seen: number[] = [];
    await loadAll([1, 2, 3, 4], (item) => Promise.resolve(item), {
      concurrency: 2,
      marker: false,
      onProgress: (progress) => {
        expect(progress.total).toBe(4);
        seen.push(progress.settled);
      },
      yieldFrame: () => Promise.resolve(),
    });

    expect(seen.at(-1)).toBe(4);
    expect(seen).toHaveLength(4);
  });

  test("a rejected load rejects the call and starts nothing further", async () => {
    const touched: number[] = [];
    await expect(
      loadAll(
        [1, 2, 3, 4, 5, 6, 7, 8],
        async (item) => {
          touched.push(item);
          if (item === 2) throw new Error("model 2 is missing");
          await Promise.resolve();
          return item;
        },
        { concurrency: 2, marker: false, yieldFrame: () => Promise.resolve() },
      ),
    ).rejects.toThrow("model 2 is missing");

    // The two lanes had 1 and 2 in flight; nothing past the failure was ever requested.
    expect(touched).toEqual([1, 2]);
  });

  test("an empty list resolves to an empty list without calling load", async () => {
    const load = vi.fn();
    await expect(loadAll([], load, { marker: false })).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  test("fewer items than lanes starts one lane per item", async () => {
    let lanes = 0;
    await loadAll(
      [1, 2],
      async (item) => {
        lanes += 1;
        await Promise.resolve();
        return item;
      },
      { concurrency: 8, marker: false, yieldFrame: () => Promise.resolve() },
    );

    expect(lanes).toBe(2);
  });

  test("turning the marker off does not turn the measurement off", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const seen: number[] = [];
      await loadAll([1, 2], (item) => Promise.resolve(item), {
        concurrency: 2,
        marker: false,
        onProgress: (progress) => seen.push(progress.settled),
        yieldFrame: () => Promise.resolve(),
      });
      expect(info).not.toHaveBeenCalled();
      expect(seen).toHaveLength(2);

      await loadAll([1, 2], (item) => Promise.resolve(item), {
        concurrency: 2,
        yieldFrame: () => Promise.resolve(),
      });
      const line = info.mock.calls
        .map((call) => String(call[0]))
        .find((c) => c.includes("TN_LOAD_ALL"));
      expect(line).toBeDefined();
      expect(line).toContain("concurrency=2");
      expect(line).toContain("overridden=true");
    } finally {
      info.mockRestore();
    }
  });

  test.each([0, -2, 2.5, Number.NaN])(
    "fails closed on a nonsensical concurrency (%s)",
    async (concurrency) => {
      await expect(
        loadAll([1], (item) => Promise.resolve(item), { concurrency, marker: false }),
      ).rejects.toThrow("TN_LOAD_ALL_CONCURRENCY_INVALID");
    },
  );

  test("yields between items so a progress bar keeps moving", async () => {
    const { calls, yieldFrame } = countingYield();
    await loadAll([1, 2, 3, 4], (item) => Promise.resolve(item), {
      concurrency: 2,
      marker: false,
      yieldFrame,
    });

    // Two lanes, two items each: every item yields after settling, which is what stops a
    // full-width fan-out from freezing the loading screen it is supposed to be filling.
    expect(calls()).toBe(4);
  });
});

describe("addInSlices yield", () => {
  // A nested setTimeout(0) is clamped to 4 ms in Chrome (measured 4.56 ms against 0.009 ms for
  // scheduler.yield), and the native host's timer queue is frame-coupled. Both hosts provide
  // scheduler.yield, so the slice yield must take it whenever it exists.
  test("yields through scheduler.yield when the host provides it", async () => {
    const scope = globalThis as { scheduler?: unknown };
    const previous = scope.scheduler;
    const yieldSpy = vi.fn(() => Promise.resolve());
    const timeout = vi.spyOn(globalThis, "setTimeout");
    scope.scheduler = { yield: yieldSpy };
    try {
      const added: number[] = [];
      await addInSlices([1, 2, 3], (n) => added.push(n), { sliceSize: 1 });
      expect(added).toEqual([1, 2, 3]);
      expect(yieldSpy).toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      if (previous === undefined) Reflect.deleteProperty(scope, "scheduler");
      else scope.scheduler = previous;
    }
  });

  test("falls back to setTimeout where no scheduler.yield exists", async () => {
    const scope = globalThis as { scheduler?: unknown };
    const previous = scope.scheduler;
    Reflect.deleteProperty(scope, "scheduler");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      await addInSlices([1, 2], () => {}, { sliceSize: 1 });
      expect(timeout).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      if (previous !== undefined) scope.scheduler = previous;
    }
  });
});
