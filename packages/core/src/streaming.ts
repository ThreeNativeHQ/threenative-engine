import { yieldToHost } from "./warmup.js";

/**
 * Two load-time mechanisms every streaming game writes by hand, and gets wrong in the same places.
 *
 * A game that shows a loading curtain and builds its world behind it has two loops that decide how
 * long the curtain stays up, and neither is about how anything looks: the loop that **fetches** the
 * models and the loop that **attaches** the finished objects to the scene. Written naively, the
 * first is serial and the second is one-object-per-frame, and both are slow for reasons that have
 * nothing to do with the game.
 *
 * Measured in a real game (a 190 m valley, ~70 GLBs, ~400 attached objects), on the same build and
 * the same content:
 *
 * | Attach loop  | Detail tier |
 * | ------------ | ----------- |
 * | 1 per frame  | 16.5 s      |
 * | 6 per frame  | 11.26 s     |
 * | 24 per frame | 9.39 s      |
 * | 256 per frame| **6.89 s**  |
 * | all at once  | 7.18 s      |
 *
 * and the fetch loop: 52 models one at a time took **38.4 s**; six at a time took **8.8 s**.
 *
 * Neither of these decides how anything looks. `addInSlices` never creates an object and never
 * chooses where it goes — it is handed a list and the game's own `add`. `loadAll` never chooses
 * what to load — it is handed a list and the game's own `load`. Geometry, material, colour,
 * texture, curve and timing stay with the game in both, and a game can change its appearance
 * completely without editing either.
 *
 * What they are not is code a game can get right portably by itself, which is why they live here.
 * Yielding correctly is a platform seam: awaiting `requestAnimationFrame` deadlocks a host whose
 * frames are pumped by the code doing the waiting, racing it against a timer reorders the frame
 * sequence a harness observes, and a hard-coded `setTimeout(16)` is neither a frame on the native
 * runtime nor a frame on a machine that cannot hold 60. See `yieldToHost` in `warmup.ts` for the
 * two wrong versions that came before the one both of these use.
 */

/** How far a sliced attachment has got, reported once per slice. */
export interface IAddInSlicesProgress {
  /** Objects attached so far. Never greater than `total`. */
  readonly added: number;
  /** Objects the run was given. Known before the first slice. */
  readonly total: number;
}

export interface IAddInSlicesOptions {
  /**
   * Objects attached between presented frames, when the game wants that count.
   *
   * Omitted, a slice ends on elapsed time instead: the loop measures what the game's own `add`
   * costs, in the place where the cost is paid, and presents a frame once the slice has run for its
   * budget. Objects that cost nothing stop paying a frame each, and objects that cost more than any
   * fixed count allows get cut sooner than that count would. Given, the count decides and the budget
   * is not used at all.
   */
  readonly sliceSize?: number;
  /** Called once per slice, and once more for a partial final slice. */
  readonly onProgress?: (progress: IAddInSlicesProgress) => void;
  /**
   * How the run hands the loop back to the host between slices. Defaults to yielding one
   * macrotask, which is one native-runtime loop iteration and therefore one presented frame.
   */
  readonly yieldFrame?: () => Promise<void>;
  /**
   * Asked before every object; a false answer stops the run.
   *
   * This is how a scene that can be torn down mid-attach stays correct. A generation invalidated
   * by a restart, a scene change, or an HMR reload must stop attaching into a graph that is no
   * longer current, and it must do so **without throwing** — a throw here is indistinguishable
   * from a real attachment failure at the catch site, and games end up reporting a teardown as an
   * asset error. The stop is reported instead, as `stopped` on the report.
   */
  readonly while?: () => boolean;
  /** Silences the `TN_ADD_SLICES` marker. Never silences the report. Default true (on). */
  readonly marker?: boolean;
}

/** What a sliced attachment did, so a caller can report it rather than assume it. */
export interface IAddInSlicesReport {
  /** Objects actually handed to `add`. */
  readonly added: number;
  /** Objects the run was given. */
  readonly total: number;
  /** Slices the work was cut into: one host turn between each, several of which can share a frame. */
  readonly slices: number;
  /** Wall-clock milliseconds the run took, attaching and yielding together. */
  readonly elapsedMs: number;
  /**
   * Objects per slice this run actually landed on: the count the game chose, or — when
   * the budget chose — the measured average, which is the number a caller copies into `sliceSize`.
   */
  readonly sliceSize: number;
  /** Whether that count came from the game rather than from the engine. */
  readonly sliceSizeOverridden: boolean;
  /** Milliseconds of attaching one slice may spend before it presents. Absent when the game gave a count. */
  readonly sliceBudgetMs?: number;
  /** True when `while` ended the run early. `added` is then less than `total`. */
  readonly stopped: boolean;
}

/** How far a bounded-concurrency load has got, reported once per settled item. */
export interface ILoadAllProgress {
  /** Loads that have resolved. */
  readonly settled: number;
  /** Loads the run was given. Known before the first one starts. */
  readonly total: number;
}

export interface ILoadAllOptions {
  /**
   * Loads in flight at once. Default 6.
   *
   * Bounded rather than unbounded, because a full-width fan-out coalesces its completion callbacks
   * into 100-200 ms tasks and freezes the loading screen it is filling — which reads as the hang
   * the concurrency was added to remove. Six is also the per-host connection limit a browser
   * applies to HTTP/1.1, so a larger number frequently buys queueing rather than parallelism.
   */
  readonly concurrency?: number;
  /** Called after each load settles. */
  readonly onProgress?: (progress: ILoadAllProgress) => void;
  /**
   * How the run hands the loop back to the host after each settled load. Defaults to yielding one
   * macrotask, which is what keeps a progress bar moving while the lanes are busy.
   */
  readonly yieldFrame?: () => Promise<void>;
  /** Silences the `TN_LOAD_ALL` marker. Never silences `onProgress`. Default true (on). */
  readonly marker?: boolean;
}

const DEFAULT_SLICE_BUDGET_MS = 8;
export const DEFAULT_CONCURRENCY = 6;

const now = (): number => globalThis.performance?.now() ?? Date.now();

function assertWholeAtLeastOne(value: number, name: string, code: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${code}: ${name} must be a whole number of at least one, received ${String(value)}.`,
    );
  }
}

/**
 * Attach a built list of objects to the scene in slices, presenting a frame between each.
 *
 * The objects are already built and already the game's; this decides only *when* each one joins
 * the graph. Order is the list's order, and there is no option to change it — an attach loop that
 * reordered its input would change which object a positional lookup finds.
 *
 * @situation add hundreds of built objects to the scene without one multi-second frame
 * @situation stream a detail tier in behind a loading curtain without the page looking hung
 * @example
 * const report = await addInSlices(detailObjects, (object) => ctx.add(object), {
 *   onProgress: ({ added, total }) => setProgress(added / total),
 *   while: () => generation.live,
 * });
 */
export async function addInSlices<T>(
  objects: Iterable<T>,
  add: (object: T, index: number) => void,
  options: IAddInSlicesOptions = {},
): Promise<IAddInSlicesReport> {
  const sliceSize = options.sliceSize;
  if (sliceSize !== undefined) {
    assertWholeAtLeastOne(sliceSize, "sliceSize", "TN_ADD_SLICES_SLICE_INVALID");
  }
  const countSlices = sliceSize !== undefined;
  const sliceBudgetMs = countSlices ? undefined : DEFAULT_SLICE_BUDGET_MS;
  const yieldFrame = options.yieldFrame ?? yieldToHost;
  const shouldContinue = options.while;
  const startedAt = now();

  // Materialised once: the caller may pass any iterable, and `total` has to be known before the
  // first slice so a progress bar has a denominator rather than a moving one.
  const list = [...objects];
  const total = list.length;

  let added = 0;
  let reported = 0;
  let slices = 0;
  let stopped = false;
  let sliceStartedAt = now();

  const flush = async (yieldAfter: boolean): Promise<void> => {
    slices += 1;
    reported = added;
    options.onProgress?.({ added, total });
    if (yieldAfter) {
      await yieldFrame();
      // The presented frame is not part of the next slice's work.
      if (sliceBudgetMs !== undefined) sliceStartedAt = now();
    }
  };

  /** A slice ends on the count the game gave, or on the budget this run has spent. */
  const sliceSpent = (): boolean =>
    sliceSize !== undefined
      ? added % sliceSize === 0
      : now() - sliceStartedAt >= DEFAULT_SLICE_BUDGET_MS;

  for (let index = 0; index < total; index += 1) {
    if (shouldContinue !== undefined && !shouldContinue()) {
      stopped = true;
      break;
    }
    add(list[index] as T, index);
    added += 1;
    // Never after the final object: the caller is about to render anyway, and one more empty frame
    // would only be added to the load. The clock is read per object, because `performance.now()` is
    // cheap beside the game's own `add` and a fixed count cannot see what that `add` costs.
    if (added < total && sliceSpent()) await flush(true);
  }
  if (added > reported) await flush(false);

  const report: IAddInSlicesReport = {
    added,
    total,
    slices,
    elapsedMs: now() - startedAt,
    // Measured rather than assumed: with no count to divide by, the average is what the run did.
    sliceSize: sliceSize ?? Math.round(added / Math.max(slices, 1)),
    sliceSizeOverridden: countSlices,
    sliceBudgetMs,
    stopped,
  };
  if (options.marker !== false) {
    console.info(
      `TN_ADD_SLICES added=${String(added)} total=${String(total)} slices=${String(slices)} ` +
        `sliceSize=${String(report.sliceSize)} overridden=${String(countSlices)} ` +
        `budgetMs=${String(sliceBudgetMs ?? "none")} ` +
        `stopped=${String(stopped)} ms=${report.elapsedMs.toFixed(1)}`,
    );
  }
  return report;
}

/**
 * Load a list with bounded concurrency, and hand the results back **in the input's order**.
 *
 * The ordering is the whole point and has no override. `Promise.all` already keeps order but runs
 * everything at once; a hand-rolled worker pool bounds the lanes but pushes results as they land,
 * so the array comes back in completion order — whatever the network happened to return. A game
 * that picks from that list positionally then places a different model in the same spot on every
 * load, and its world is never the same twice. That defect shipped in a real game and is why this
 * writes each result to its item's own index and never appends.
 *
 * Fails closed like `Promise.all`: the first rejection rejects the call, and no lane starts a load
 * it had not already begun.
 *
 * @situation load many models or textures in parallel instead of one at a time
 * @situation keep a loading screen moving while a list of assets downloads
 * @example
 * const species = await loadAll(names, (name) => ctx.assets.model(`flora/${name}.glb`), {
 *   onProgress: ({ settled, total }) => setProgress(settled / total),
 * });
 */
export async function loadAll<TIn, TOut>(
  items: readonly TIn[],
  load: (item: TIn, index: number) => Promise<TOut>,
  options: ILoadAllOptions = {},
): Promise<TOut[]> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  assertWholeAtLeastOne(concurrency, "concurrency", "TN_LOAD_ALL_CONCURRENCY_INVALID");
  const concurrencyOverridden = options.concurrency !== undefined;
  const yieldFrame = options.yieldFrame ?? yieldToHost;
  const startedAt = now();
  const total = items.length;

  const results = new Array<TOut>(total);
  // Lanes pull from one shared cursor rather than taking a contiguous chunk each: a chunked split
  // runs at the speed of the slowest item in each chunk, and asset lists routinely range from a
  // 40 kB clover to a 4 MB pine.
  let next = 0;
  let settled = 0;
  let failed = false;

  const lane = async (): Promise<void> => {
    for (;;) {
      // A lane that keeps pulling after a sibling has failed spends bandwidth on a load whose
      // result is already going to be thrown away.
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= total) return;
      try {
        // The slot, never a push. See this function's doc comment.
        results[index] = await load(items[index] as TIn, index);
      } catch (error) {
        failed = true;
        throw error;
      }
      settled += 1;
      options.onProgress?.({ settled, total });
      await yieldFrame();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => lane()));

  if (options.marker !== false) {
    console.info(
      `TN_LOAD_ALL items=${String(total)} concurrency=${String(concurrency)} ` +
        `overridden=${String(concurrencyOverridden)} ms=${(now() - startedAt).toFixed(1)}`,
    );
  }
  return results;
}
