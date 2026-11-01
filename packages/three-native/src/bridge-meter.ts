/**
 * The bridge-read guard (PRD-748): on the web engine every read of a bridged property crosses JS to
 * Wasm, so code that looks free in plain three.js (a light's intensity read in each uniform callback,
 * a scene walk per frame) costs real time here. The back end keeps what it can (the property mirror
 * and the hierarchy cache in `browser-backend.ts`); this meter names what is left.
 *
 * One frame in each window of `WINDOW_FRAMES` safe points, after `WARMUP_FRAMES`, is a census frame:
 * every crossing counts by name, and a get of the same object's same property again in that frame is
 * a redundant read, nothing changed it in between that the game could not have kept. The census frame
 * also takes one stack for each name read redundantly, so the verdict names the caller.
 *
 * **The rule is derived, never a constant an author revisits.** It fires when the redundant reads,
 * at this host's own measured cost per crossing, take more than `REDUNDANT_SHARE` of the frame's
 * median interval: the frame's own length, so the guard holds on Xvfb and on a loaded host. The line
 * is `TN_BRIDGE_WARNING`, which a playtest fails on (`packages/playtest` perf warnings).
 *
 * What *all* crossings cost is an observation, not a defect: a game that reads 995 distinct
 * properties once each has nothing to batch, so no fix exists and a warning about it is noise every
 * game pays. It rides the census a debug run or a playtest already asked for, and the debug report
 * ranks it (`bridgeCrossingMs`); the always-on line stays on repeated reads.
 */

import { debugRequested } from "./debug-telemetry.js";

export const BRIDGE_WARNING_MARKER = "TN_BRIDGE_WARNING";
/**
 * Set above zero by the playtest bridge while it samples: its scene walk reads every mesh's material
 * and bounds inside the census frame, and no player run makes those reads.
 */
/**
 * Set to `true` by a playtest that bounds engine counters (`engineCost`): every census then prints
 * `TN_BRIDGE_CENSUS` with its top crossings and their callers, so an over-bound counter names who
 * crossed. The counters themselves ride TN_FRAME_BUDGET.counters.engine.
 */
export const ENGINE_COST_KNOB = "__THREENATIVE_ENGINE_COST__";
export const BRIDGE_CENSUS_MARKER = "TN_BRIDGE_CENSUS";

export const PLAYTEST_OBSERVING_GLOBAL = "__tnPlaytestObserving";

/** Safe points before the first census: loading and the first frames build, so their reads are not steady. */
export const WARMUP_FRAMES = 120;
/** One census frame in each window, so the census costs a frame in this many. */
export const WINDOW_FRAMES = 120;
/** The share of the frame that redundant reads may take; past it the waste is worth a named fix. */
export const REDUNDANT_SHARE = 1 / 50;

interface ICensus {
  readonly byName: Map<string, number>;
  /** `<object key> <name>` -> gets in this frame. */
  readonly byRead: Map<string, number>;
  readonly redundantByName: Map<string, number>;
  readonly callers: Map<string, string>;
  /** The census prints itself (ENGINE_COST_KNOB), so it names a caller for every crossing, not only re-reads. */
  readonly printed: boolean;
}

export interface IBridgeMeterHost {
  now(): number;
  /** The cost of one crossing on this host, in microseconds; asked once, at the first census. */
  crossingMicros(): number;
  typeName(type: number): string;
  /** The current stack, as `new Error().stack` gives it. */
  stack(): string | undefined;
  report(line: string): void;
}

export interface IBridgeMeter {
  /** True while a census frame counts: the back end records each crossing only then. */
  readonly counting: boolean;
  record(kind: string, self: { readonly key: string; readonly type: number }, name: string): void;
  /** The safe point, once per renderer frame. */
  frame(): void;
}

/**
 * The first frame of `stack` outside the back end and this meter (the files of its first two frames:
 * the stack call, then `record`), and the two after it: `fn (file:line) < fn (file:line)`. A bundle
 * that puts the game in the back end's file falls back to the fourth frame, the one above the accessor.
 */
export function callerOf(stack: string | undefined): string {
  const frames = (stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => line.slice(3));
  const fileOf = (frame: string) => /\(?([^()\s]+?)(?::\d+){1,2}\)?$/u.exec(frame)?.[1] ?? frame;
  const own = new Set(frames.slice(0, 2).map(fileOf));
  let at = frames.findIndex(
    (frame) =>
      !own.has(fileOf(frame)) &&
      !/(?:browser-backend|debug-telemetry|bridge-meter)\.[jt]s(?:[:?]|$)/u.test(fileOf(frame)),
  );
  if (at < 0) at = Math.min(3, frames.length - 1);
  const short = (frame: string) =>
    frame.replace(
      /(?:[a-z]+:\/\/[^/]+)?\/(?:[^/()\s]*\/)*([^/()\s]+\/[^/()\s]+?)(?:\?[^:)\s]*)?(:\d+)(?::\d+)?/u,
      "$1$2",
    );
  return (
    frames
      .slice(at, at + 3)
      .map(short)
      .join(" < ") || "unknown"
  );
}

export function createBridgeMeter(host: IBridgeMeterHost): IBridgeMeter {
  let frames = 0;
  let last: number | undefined;
  const intervals: number[] = [];
  let census: ICensus | undefined;
  let micros: number | undefined;
  let window = 0;
  const finish = (done: ICensus): void => {
    window += 1;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    // What one crossing costs on this host, asked once. A debug-off frame that repeated no read
    // never pays for the calibration.
    const costMicros = (): number => {
      micros ??= host.crossingMicros();
      if (!Number.isFinite(micros) || micros < 0)
        throw new Error("TN_BRIDGE_WARNING: invalid crossing calibration.");
      return micros;
    };
    const medianFrameMs = (): number => {
      const sorted = [...intervals].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] as number;
    };
    let redundant = 0;
    for (const count of done.redundantByName.values()) redundant += count;
    if (done.printed) {
      let crossed = 0;
      for (const count of done.byName.values()) crossed += count;
      const top = [...done.byName]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, perFrame]) => ({
          name,
          perFrame,
          caller: done.callers.get(name) ?? "unknown",
        }));
      // The debug path's own observation: what every crossing of the frame cost, at this host's
      // calibration. It is not a warning — a game with no repeated read has nothing to fix — so it
      // rides the census a debug run or a playtest bound already asks for.
      const frameMs = intervals.length === 0 ? undefined : medianFrameMs();
      const crossingMs = crossed === 0 ? undefined : (crossed * costMicros()) / 1000;
      host.report(
        `${BRIDGE_CENSUS_MARKER}:${JSON.stringify({
          window,
          crossings: crossed,
          ...(frameMs === undefined || crossingMs === undefined
            ? {}
            : {
                crossingUs: round(costMicros()),
                crossingMs: round(crossingMs),
                share: round(crossingMs / frameMs),
              }),
          redundantReads: redundant,
          top,
        })}`,
      );
    }
    if (redundant === 0 || intervals.length === 0) return;
    const frameMs = medianFrameMs();
    const crossingUs = costMicros();
    const redundantMs = (redundant * crossingUs) / 1000;
    if (!(redundantMs > frameMs * REDUNDANT_SHARE)) return;
    const top = [...done.redundantByName]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({
        name,
        perFrame: done.byName.get(name) ?? count,
        redundant: count,
        caller: done.callers.get(name) ?? "unknown",
      }));
    host.report(
      `${BRIDGE_WARNING_MARKER}:${JSON.stringify({
        window,
        frameMs: round(frameMs),
        crossingUs: round(crossingUs),
        redundantReads: redundant,
        redundantMs: round(redundantMs),
        share: round(redundantMs / frameMs),
        top,
        fix: `${top[0]?.name ?? "a property"} is read again in one frame from ${top[0]?.caller ?? "unknown"}: read it once per frame into a local and pass that, or move the check out of the per-frame callback.`,
      })}`,
    );
  };
  return {
    get counting() {
      return census !== undefined;
    },
    record(kind, self, name) {
      if (census === undefined) return;
      if (((globalThis as Record<string, unknown>)[PLAYTEST_OBSERVING_GLOBAL] as number) > 0)
        return;
      const label = `${kind} ${host.typeName(self.type)}.${name}`;
      census.byName.set(label, (census.byName.get(label) ?? 0) + 1);
      if (census.printed && !census.callers.has(label))
        census.callers.set(label, callerOf(host.stack()));
      if (kind !== "get") return;
      const read = `${self.key} ${name}`;
      const seen = (census.byRead.get(read) ?? 0) + 1;
      census.byRead.set(read, seen);
      if (seen < 2) return;
      census.redundantByName.set(label, (census.redundantByName.get(label) ?? 0) + 1);
      if (!census.callers.has(label)) census.callers.set(label, callerOf(host.stack()));
    },
    frame() {
      const now = host.now();
      if (last !== undefined) {
        intervals.push(now - last);
        if (intervals.length > WINDOW_FRAMES) intervals.shift();
      }
      last = now;
      frames += 1;
      if (census !== undefined) {
        const done = census;
        census = undefined;
        finish(done);
      } else if (frames > WARMUP_FRAMES && frames % WINDOW_FRAMES === 0) {
        census = {
          byName: new Map(),
          byRead: new Map(),
          redundantByName: new Map(),
          callers: new Map(),
          printed:
            debugRequested() || (globalThis as Record<string, unknown>)[ENGINE_COST_KNOB] === true,
        };
      }
    },
  };
}
