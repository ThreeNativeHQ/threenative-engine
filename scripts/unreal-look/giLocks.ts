/**
 * Ratchet locks for the GI calibration scenes (PRD-654). An approved round (PRD-647) or an approved capture
 * becomes a floor under its regions, so that no later change makes them worse without anyone seeing it:
 *
 *   pnpm unreal-look:calibrate --lock <round> [--tighten | --relax]    write tools/unreal-reference/gi/parity-locks.json
 *   pnpm unreal-look:compare --write-locks <head> --scene gi:<name> --layer L9 --captures <run> --noise <run>,<run>
 *   pnpm unreal-look:compare --check --scene gi:<name> --captures <run1> --captures <run2> [--layer L7-high]
 *
 * A lock holds, per scene, layer, pose and region, the worst dP50 and deltaE and the lowest ID overlap of the
 * round. Each bound is widened by the run-to-run noise that the two runs of the round measured, and the two
 * color bounds by one display level of the reference median, the smallest step the metric can take. The check
 * fails when a region of a new capture is past its bound, when a locked region or a run is missing, and when
 * the two runs of the new capture differ by more than the locked noise. A lock tightens only on request
 * (--tighten) and loosens only on request (--relax). Every comparison reads the committed Unreal statistics
 * (reference-stats.json), so the check needs no Unreal capture. A lock also records a digest of the committed
 * scene and Unreal reference that it was cut against (`basis`). When another lane rebuilds the scene, the
 * approved bounds no longer apply: the check says so (LOCK_STALE) and a new approved round re-cuts the lock.
 *
 * The L9 frames of the owner preview loop come one per head and have no ID frame. A lock for them is cut from
 * one capture, takes its noise from the pairs of runs of other heads (`--noise`), has no overlap bound, and is
 * checked on one capture (`runs: 1`). The overlap of a layer is the business of its L7 lock.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IRow, ciede2000, lab } from "./compare.js";
import { compareGiToUnreal, sceneDir, sceneKey } from "./gi.js";

export const GI_LOCK_FILE = path.resolve(
  import.meta.dirname,
  "../../tools/unreal-reference/gi/parity-locks.json",
);

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}

/** The part of a compare row that a lock reads. `unreal` gives the reference median that sets the metric step. */
export type IMeasuredRow = Pick<IRow, "cell" | "region" | "deltaE" | "dP50" | "iou"> & {
  unreal?: { p50: number } | null;
  /** The compare verdict against the layer's thresholds. Absent in a hand-built row, null when nothing was evaluated. */
  pass?: boolean | null;
};

export interface IGiLock {
  scene: string;
  layer: string;
  pose: string;
  region: string;
  /** The approved round, or the head of the approved capture, that cut the lock. */
  round: string;
  /** Digest of the committed scene and Unreal reference that the round was measured against (sceneBasis). */
  basis: string;
  maxDP50: number;
  maxDeltaE: number;
  /** The lowest ID overlap. Absent when the capture that cut the lock has no ID frame of its own. */
  minIoU?: number;
  /** Spread of each metric between the two runs of that round. */
  noiseDP50: number;
  noiseDeltaE: number;
  noiseIoU?: number;
  /** The captures that cut the lock, when that is one: the check then reads one capture. Absent means two. */
  runs?: number;
}

const METRICS = [
  { name: "dP50", limit: "maxDP50", noise: "noiseDP50", floor: false },
  { name: "deltaE", limit: "maxDeltaE", noise: "noiseDeltaE", floor: false },
  { name: "iou", limit: "minIoU", noise: "noiseIoU", floor: true },
] as const;

/** Digits kept in a bound. A bound is rounded away from the value, so the value it came from always holds. */
const SIGNIFICANT = 5;
/** One part in a million: a bound and the value it was cut from are the same number. */
const SAME = 1e-6;
/** Two runs of a new capture may differ by the locked noise plus this share of the bound. */
const AGREE = 1e-4;
/** A lock that does not say how many captures cut it was cut from the two runs of a round. */
const ROUND_RUNS = 2;

export const lockKey = (lock: Pick<IGiLock, "scene" | "layer" | "pose" | "region">) =>
  `${lock.scene} ${lock.layer} ${lock.pose} ${lock.region}`;
const rowKey = (row: Pick<IMeasuredRow, "cell" | "region">) => `${row.cell}\u0000${row.region}`;
const show = (value: number) => Number(value.toPrecision(4));
const index = (rows: readonly IMeasuredRow[]) =>
  new Map(rows.map((row) => [rowKey(row), row] as const));

function significant(value: number, toward: "up" | "down"): number {
  if (value === 0) return 0;
  const scale = 10 ** (SIGNIFICANT - 1 - Math.floor(Math.log10(Math.abs(value))));
  const scaled = value * scale;
  const nearest = Math.round(scaled);
  // A value within float noise of a digit boundary is on it: 0.99 - 0.97 is 0.02, not 0.020001.
  if (Math.abs(scaled - nearest) <= 1e-9 * Math.abs(scaled)) return nearest / scale;
  return (toward === "up" ? Math.ceil : Math.floor)(scaled) / scale;
}

/** One display level of the reference median: the step by which dP50 and deltaE move when a median moves. */
function displayLevel(reference: number | undefined): { dP50: number; deltaE: number } {
  if (reference === undefined) return { dP50: 0, deltaE: 0 };
  const grey = Math.min(Math.max(Math.round(reference), 0), 254);
  return {
    dP50: 1 / Math.max(reference, 1),
    deltaE: ciede2000(lab([grey, grey, grey]), lab([grey + 1, grey + 1, grey + 1])),
  };
}

function finite(value: number | null | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("MISSING_METRIC", `${what}: the compare gave no value`);
  return value;
}

/**
 * A digest of what a lock is measured against: the committed Unreal statistics, the Unreal ID frames that give
 * the region masks, and the scene definition. The time stamp of the statistics file and the `motion` runs of
 * the scene definition are left out: neither sets a measurement of a still pose, so writing the same statistics
 * again or adding a motion run keeps the digest.
 */
export function sceneBasis(scene: string, dir = sceneDir(scene)): string {
  const stats = JSON.parse(readFileSync(path.join(dir, "reference-stats.json"), "utf8")) as {
    resolution?: unknown;
    cells?: unknown;
  };
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ resolution: stats.resolution, cells: stats.cells }));
  for (const name of readdirSync(path.join(dir, "id")).sort())
    hash.update(`\0${name}\0`).update(readFileSync(path.join(dir, "id", name)));
  const { motion: _motion, ...definition } = JSON.parse(
    readFileSync(path.join(dir, "scene.json"), "utf8"),
  ) as { motion?: unknown };
  hash.update("\0scene.json\0").update(JSON.stringify(definition));
  return hash.digest("hex").slice(0, 12);
}

/** The locks of a scene and layer that another scene or Unreal reference than `basis` cut: their bounds do not apply. */
export function staleLocks(
  locks: readonly IGiLock[],
  scene: string,
  layer: string,
  basis: string,
): IGiLock[] {
  return locks.filter(
    (lock) => lock.scene === scene && lock.layer === layer && lock.basis !== basis,
  );
}

/** The widest spread of one metric between the runs of any one group, for one region of one pose. */
function widestSpread(
  groups: readonly (readonly ReadonlyMap<string, IMeasuredRow>[])[],
  key: string,
  name: (typeof METRICS)[number]["name"],
  what: string,
): number {
  return Math.max(
    ...groups.map((group) => {
      const values = group.map((map) => finite((map.get(key) as IMeasuredRow)[name], what));
      return Math.max(...values) - Math.min(...values);
    }),
  );
}

/**
 * The locks that an approved capture makes, one per region of each pose. Two or more runs measure their own noise.
 * One run takes it from `noise`: groups of two or more runs of other captures, the widest spread of a group
 * per region. A capture with no overlap (every `iou` null) gets no overlap bound.
 */
export function lockCells(
  round: string,
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  basis: string,
  noise: readonly (readonly (readonly IMeasuredRow[])[])[] = [],
): IGiLock[] {
  refuseRuns(runs, noise);
  const maps = runs.map(index);
  const [first] = maps as [Map<string, IMeasuredRow>];
  for (const map of maps)
    if (map.size !== first.size || [...map.keys()].some((key) => !first.has(key)))
      fail("RUN_MISMATCH", "the runs do not measure the same regions of the same poses");
  if (first.size === 0) fail("RUN_MISMATCH", `${scene} ${layer}: the runs measure no region`);
  const groups = runs.length > 1 ? [maps] : noise.map((group) => group.map(index));
  if (groups.flat().some((map) => [...first.keys()].some((key) => !map.has(key))))
    fail("RUN_MISMATCH", "the noise runs do not measure the regions of the capture");
  return [...first.values()].map((row) =>
    cutRow(row, { round, scene, layer, basis, maps, groups }),
  );
}

/**
 * The rows of the regions that are at parity with Unreal in every run (the compare verdict passes), and the regions
 * that are not, as `<cell> <region>`. A lock exists only where the region is at parity: a bound on a region that
 * is far from Unreal would freeze the gap. A row with no verdict at all (`pass` absent) stays.
 */
export function splitParity(runs: readonly (readonly IMeasuredRow[])[]): {
  runs: IMeasuredRow[][];
  off: string[];
} {
  const names = (row: IMeasuredRow) => `${row.cell} ${row.region}`;
  const off = new Set(
    runs.flatMap((run) =>
      run.filter((row) => row.pass !== undefined && row.pass !== true).map(names),
    ),
  );
  return {
    runs: runs.map((run) => run.filter((row) => !off.has(names(row)))),
    off: [...off],
  };
}

/** A cut takes two runs, or one run and the noise of other captures in groups of two runs. */
function refuseRuns(runs: readonly unknown[], noise: readonly (readonly unknown[])[]): void {
  if (runs.length === 0 || (runs.length === 1 && noise.length === 0))
    fail(
      "TOO_FEW_RUNS",
      `${runs.length} run(s): a lock is cut from two runs, so that its noise is measured, or from one run and the noise of other captures (--noise)`,
    );
  if (runs.length > 1 && noise.length > 0)
    fail(
      "BAD_INPUT",
      "--noise gives the noise of a single capture; two or more runs measure their own",
    );
  if (noise.some((group) => group.length < 2))
    fail("TOO_FEW_RUNS", "a --noise group is the two runs of one capture");
}

interface ICut {
  round: string;
  scene: string;
  layer: string;
  basis: string;
  /** The runs of the capture, by region. */
  maps: readonly ReadonlyMap<string, IMeasuredRow>[];
  /** The runs that measure the noise: the runs of the capture, or each group of `--noise`. */
  groups: readonly (readonly ReadonlyMap<string, IMeasuredRow>[])[];
}

/** The lock of one region of one pose. */
function cutRow(row: IMeasuredRow, { round, scene, layer, basis, maps, groups }: ICut): IGiLock {
  if (!row.cell.startsWith(`${scene}/`))
    fail("BAD_INPUT", `${row.cell} is not a cell of the scene ${scene}`);
  const key = rowKey(row);
  const at = maps.map((map) => map.get(key) as IMeasuredRow);
  const step = displayLevel(row.unreal?.p50);
  const lock: Record<string, string | number> = {
    scene,
    layer,
    pose: row.cell.slice(scene.length + 1),
    region: row.region,
    round,
    basis,
  };
  for (const metric of METRICS) {
    // A capture with no ID frame of its own has no overlap to lock.
    if (metric.floor && at.every((r) => r.iou === null)) continue;
    const what = `${row.cell}/${row.region} ${metric.name}`;
    const values = at.map((r) => finite(r[metric.name], what));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = widestSpread(groups, key, metric.name, what);
    const level = metric.name === "iou" ? 0 : step[metric.name];
    lock[metric.limit] = metric.floor
      ? Math.max(significant(mean - spread, "down"), 0)
      : significant(mean + spread + level, "up");
    lock[metric.noise] = significant(spread, "up");
  }
  if (maps.length === 1) lock.runs = 1;
  return lock as unknown as IGiLock;
}

export interface IMerge {
  locks: IGiLock[];
  added: string[];
  /** Cells whose bounds moved to the new round (--tighten or --relax). */
  moved: string[];
  /** Cells where the new round is tighter and the lock stayed (no --tighten). */
  improved: string[];
  /** Cells where the new round is looser and the lock stayed (no --relax), as one line per bound. */
  looser: string[];
  /** Cells whose lock was cut against another scene or Unreal reference (--relax re-cuts them). */
  stale: string[];
  /** Locks that the cut removed because their region is not at parity with Unreal. */
  removed: string[];
}

/**
 * The lock file after a round. A cell that no lock covers is added. A cell that a lock covers keeps its
 * bounds, unless the round is tighter and `tighten` says so, or looser and `relax` says so. A round that
 * no longer measures a cell that its scene and layer have locked is refused: no round drops a cell.
 */
export function mergeLocks(
  stored: readonly IGiLock[],
  fresh: readonly IGiLock[],
  mode: { tighten?: boolean; relax?: boolean } = {},
  off: ReadonlySet<string> = new Set(),
): IMerge {
  const removed = stored.filter((lock) => off.has(lockKey(lock)));
  const existing = stored.filter((lock) => !off.has(lockKey(lock)));
  const old = new Map(existing.map((lock) => [lockKey(lock), lock] as const));
  const next = new Map(old);
  const out: IMerge = {
    locks: [],
    added: [],
    moved: [],
    improved: [],
    looser: [],
    stale: [],
    removed: removed.map(lockKey),
  };
  for (const lock of fresh) {
    const key = lockKey(lock);
    const was = old.get(key);
    if (was === undefined) {
      next.set(key, lock);
      out.added.push(key);
      continue;
    }
    const { better, looser, stale } = compareBounds(was, lock, key);
    out.looser.push(...looser);
    if (stale) out.stale.push(key);
    // A stale or looser lock is replaced on --relax, a tighter one on --tighten.
    if (stale || looser.length > 0 ? mode.relax : better && mode.tighten) {
      next.set(key, lock);
      out.moved.push(key);
    } else if (better) out.improved.push(key);
  }
  refuseDropped(existing, fresh);
  if (!mode.relax) {
    refuseStale(out.stale);
    refuseLooser(out.looser);
  }
  out.locks = [...next.values()];
  return out;
}

/** A lock cut against another scene or Unreal reference cannot judge this round: a new baseline is accepted on purpose. */
function refuseStale(stale: readonly string[]): void {
  if (stale.length > 0)
    fail(
      "LOCK_STALE",
      `${stale.length} locked cell(s) were cut against another scene or Unreal reference than the committed one: ${stale.slice(0, 5).join("; ")}${stale.length > 5 ? "; ..." : ""}. Their bounds do not carry over; pass --relax to cut them again from this approved round`,
    );
}

/** A round that is looser than a lock on any bound is a regression: it is refused unless --relax accepts it. */
function refuseLooser(looser: readonly string[]): void {
  if (looser.length > 0)
    fail(
      "LOCK_LOOSER",
      `the round is looser than the lock on ${looser.length} bound(s): ${looser.slice(0, 5).join("; ")}${looser.length > 5 ? "; ..." : ""}. Fix the regression, or pass --relax to accept it on purpose`,
    );
}

/**
 * How a fresh lock stands against the stored one: tighter on some bound, and the bounds on which it is looser.
 * Bounds cut against another scene basis are not comparable: the lock is stale and says nothing else.
 * A bound that the fresh lock does not have is looser, one that only the fresh lock has is tighter.
 */
function compareBounds(
  was: IGiLock,
  lock: IGiLock,
  key: string,
): { better: boolean; looser: string[]; stale: boolean } {
  if (was.basis !== lock.basis) return { better: false, looser: [], stale: true };
  let better = false;
  const looser: string[] = [];
  for (const metric of METRICS) {
    const tolerance = SAME * Math.abs(was[metric.limit] ?? 0);
    for (const field of [metric.limit, metric.noise] as const) {
      // A larger noise allows more, so it counts like a ceiling.
      const step = moved(
        was[field],
        lock[field],
        metric.floor && field === metric.limit,
        tolerance,
      );
      if (step > 0) better = true;
      else if (step < 0) looser.push(`${key} ${field}: ${was[field]} -> ${lock[field] ?? "none"}`);
    }
  }
  return { better, looser, stale: false };
}

/** How one bound moved: 1 when tighter, -1 when looser, 0 when it stayed. A bound that only one lock has counts as a step. */
function moved(
  before: number | undefined,
  after: number | undefined,
  floor: boolean,
  tolerance: number,
): number {
  if (before === undefined || after === undefined)
    return before === after ? 0 : before === undefined ? 1 : -1;
  const tighter = floor ? after - before : before - after;
  return Math.abs(tighter) <= tolerance ? 0 : Math.sign(tighter);
}

/** A round that no longer measures a cell of a scene and layer it locked is refused, with or without --relax. */
function refuseDropped(existing: readonly IGiLock[], fresh: readonly IGiLock[]): void {
  const groups = new Set(fresh.map((lock) => `${lock.scene} ${lock.layer}`));
  const seen = new Set(fresh.map(lockKey));
  const dropped = existing
    .filter((lock) => groups.has(`${lock.scene} ${lock.layer}`) && !seen.has(lockKey(lock)))
    .map(lockKey);
  if (dropped.length > 0)
    fail(
      "LOCK_DROPPED",
      `the round no longer measures ${dropped.length} locked cell(s): ${dropped.slice(0, 5).join("; ")}${dropped.length > 5 ? "; ..." : ""}. A round cannot drop a lock; remove the cell from the lock file by hand in a reviewed commit`,
    );
}

/** The captures that a check of these locks reads: as many as cut them, so that it sees the same noise. */
const runsNeeded = (locks: readonly IGiLock[]) =>
  Math.max(...locks.map((lock) => lock.runs ?? ROUND_RUNS));

/** The ways a capture breaks the locks of one scene and layer, one line each. Throws when it cannot check. */
export function checkGiLocks(
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  locks: readonly IGiLock[],
  basis: string,
): string[] {
  const own = locks.filter((lock) => lock.scene === scene && lock.layer === layer);
  if (own.length === 0)
    fail(
      "NO_LOCKS",
      `no lock for ${scene} at ${layer}: approve a round with pnpm unreal-look:calibrate --lock <round>`,
    );
  const stale = staleLocks(own, scene, layer, basis);
  if (stale.length > 0)
    fail(
      "LOCK_STALE",
      `${scene} ${layer}: ${stale.length} of ${own.length} lock(s) were cut against another scene or Unreal reference than the committed one (round ${[...new Set(stale.map((lock) => lock.round))].join(", ")}), so their bounds no longer apply. Approve a round on the current scene, then pnpm unreal-look:calibrate --lock <round> --relax`,
    );
  const need = runsNeeded(own);
  if (runs.length < need)
    fail(
      "TOO_FEW_RUNS",
      `${runs.length} run(s): the locks of ${scene} at ${layer} were cut from ${need}, so the check reads as many captures${need > 1 ? ", so that it sees their noise" : ""}`,
    );
  const maps = runs.map(index);
  return own.flatMap((lock) => checkLock(lock, maps));
}

/** The ways the runs break one lock, one line each. */
function checkLock(lock: IGiLock, maps: readonly ReadonlyMap<string, IMeasuredRow>[]): string[] {
  const key = rowKey({ cell: `${lock.scene}/${lock.pose}`, region: lock.region });
  const found = maps.map((map) => map.get(key));
  const absent = found.flatMap((row, i) => (row === undefined ? [i + 1] : []));
  if (absent.length > 0)
    return [
      `${lockKey(lock)}: missing from run ${absent.join(" and run ")} (locked by round ${lock.round})`,
    ];
  return METRICS.flatMap((metric) => checkMetric(lock, metric, found as IMeasuredRow[]));
}

/** The ways the runs break one bound of a lock. `found` holds the row of each run. */
function checkMetric(
  lock: IGiLock,
  metric: (typeof METRICS)[number],
  found: readonly IMeasuredRow[],
): string[] {
  const limit = lock[metric.limit];
  // A lock cut from a capture with no ID frame has no overlap bound.
  if (limit === undefined) return [];
  const name = `${lockKey(lock)} ${metric.name}`;
  const values = found.map((row) => row[metric.name]);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value)))
    return [`${name}: a run gave no value`];
  const numbers = values as number[];
  const failures = numbers.flatMap((value, i) =>
    (metric.floor ? value < limit * (1 - SAME) : value > limit * (1 + SAME))
      ? [
          `${name}: ${show(value)} is ${metric.floor ? "below" : "above"} the lock ${limit} in run ${i + 1} (round ${lock.round})`,
        ]
      : [],
  );
  const spread = Math.max(...numbers) - Math.min(...numbers);
  if (spread > (lock[metric.noise] ?? 0) + AGREE * Math.abs(limit))
    failures.push(
      `${name}: the runs differ by ${show(spread)}, more than the locked noise ${lock[metric.noise]}`,
    );
  return failures;
}

const LOCK_FIELDS = [
  "scene",
  "layer",
  "pose",
  "region",
  "round",
  "basis",
  ...METRICS.flatMap((metric) => [metric.limit, metric.noise]),
  "runs",
] as const;
/** The fields that a lock may leave out: the overlap bound pair, and the capture count. */
const OPTIONAL_FIELDS = ["minIoU", "noiseIoU", "runs"];

export function readGiLocks(file: string): IGiLock[] {
  const data: unknown = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      return fail("BAD_INPUT", `${file}: ${String(error)}`);
    }
  })();
  const list = (data as { version?: unknown; locks?: unknown } | null)?.locks;
  if (
    (data as { version?: unknown } | null)?.version !== 1 ||
    !Array.isArray(list) ||
    list.length === 0
  )
    fail(
      "BAD_INPUT",
      `${file}: expected {"version": 1, "locks": [...]} with at least one lock; an empty list locks nothing`,
    );
  const keys = new Set<string>();
  return list.map((raw: unknown, index: number) => {
    const lock = parseLock(raw, `${file} lock ${index}`);
    if (keys.has(lockKey(lock))) fail("BAD_INPUT", `${file}: ${lockKey(lock)} is locked twice`);
    keys.add(lockKey(lock));
    return lock;
  });
}

function parseLock(raw: unknown, where: string): IGiLock {
  const lock = (raw ?? {}) as Record<string, unknown>;
  for (const field of ["scene", "layer", "pose", "region", "round"])
    if (typeof lock[field] !== "string" || lock[field] === "")
      fail("BAD_INPUT", `${where}: ${field} must be a non-empty string`);
  if (typeof lock.basis !== "string" || !/^[0-9a-f]{12}$/.test(lock.basis))
    fail("BAD_INPUT", `${where}: basis must be the 12 hex digits of sceneBasis`);
  parseBounds(lock, where);
  return Object.fromEntries(
    LOCK_FIELDS.filter((field) => lock[field] !== undefined).map((field) => [field, lock[field]]),
  ) as unknown as IGiLock;
}

/** The bounds of a lock are numbers that are not negative. The overlap pair and the capture count may be left out. */
function parseBounds(lock: Record<string, unknown>, where: string): void {
  for (const metric of METRICS)
    for (const field of [metric.limit, metric.noise]) {
      const value = lock[field];
      if (value === undefined && OPTIONAL_FIELDS.includes(field)) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        fail("BAD_INPUT", `${where}: ${field} must be a non-negative number`);
    }
  if ((lock.minIoU === undefined) !== (lock.noiseIoU === undefined))
    fail("BAD_INPUT", `${where}: minIoU and noiseIoU go together`);
  if (lock.runs !== undefined && !(Number.isInteger(lock.runs) && (lock.runs as number) >= 1))
    fail("BAD_INPUT", `${where}: runs must be a whole number of at least 1`);
}

export function writeGiLocks(file: string, locks: readonly IGiLock[]): void {
  writeFileSync(file, `${JSON.stringify({ version: 1, locks }, null, 2)}\n`);
}

/**
 * Merge `fresh` into the lock file, write it and say what moved. `what` names the cut in the first line.
 * A refused merge (LOCK_LOOSER, LOCK_STALE, LOCK_DROPPED) throws before the file is written.
 */
export function writeMerged(
  file: string,
  fresh: readonly IGiLock[],
  mode: { tighten?: boolean; relax?: boolean },
  log: (line: string) => void,
  what: string,
  off: ReadonlySet<string> = new Set(),
): IMerge {
  const merged = mergeLocks(existsSync(file) ? readGiLocks(file) : [], fresh, mode, off);
  writeGiLocks(file, merged.locks);
  log(
    `locked ${what}: ${fresh.length} region(s) in ${new Set(fresh.map((lock) => lock.pose)).size} pose(s), ${merged.added.length} added, ${merged.moved.length} moved, ${merged.improved.length} tighter and kept\nwrote ${file} (${merged.locks.length} lock(s))`,
  );
  if (merged.removed.length > 0)
    log(`removed ${merged.removed.length} lock(s) off parity:\n  ${merged.removed.join("\n  ")}`);
  if (merged.improved.length > 0)
    log(
      `${merged.improved.length} region(s) are tighter in this cut: pass --tighten to ratchet them`,
    );
  if (merged.looser.length > 0)
    log(`relaxed ${merged.looser.length} bound(s) on purpose:\n  ${merged.looser.join("\n  ")}`);
  return merged;
}

/**
 * Run `use` on a compare root that holds one capture folder as its ThreeNative side and no Unreal frames.
 * An error that names a file under that root names the capture folder instead. A capture with no ID frames
 * (`ids` names the scene's folder in it and the committed Unreal ID frames) takes those for its masks.
 */
export function withOfflineRoot<T>(
  run: string,
  use: (root: string) => T,
  ids?: { key: string; dir: string },
): T {
  if (!existsSync(run)) fail("MISSING_CELL", `${run} is not a capture folder`);
  const root = mkdtempSync(path.join(os.tmpdir(), "gi-lock-"));
  const folder = path.resolve(run);
  try {
    if (ids === undefined || existsSync(path.join(folder, ids.key, "ID")))
      symlinkSync(folder, path.join(root, "threenative"));
    else borrowIds(root, folder, ids);
    return use(root);
  } catch (error) {
    if (error instanceof Error)
      error.message = error.message.replaceAll(path.join(root, "threenative"), folder);
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The ThreeNative side of a compare root: the layer folders of a capture, and the Unreal ID frames in place of its own. */
function borrowIds(root: string, folder: string, ids: { key: string; dir: string }): void {
  if (!existsSync(path.join(folder, ids.key)))
    fail("MISSING_CELL", `${folder} has no frames of ${ids.key}`);
  const scene = path.join(root, "threenative", ids.key);
  mkdirSync(scene, { recursive: true });
  for (const layer of readdirSync(path.join(folder, ids.key)))
    symlinkSync(path.join(folder, ids.key, layer), path.join(scene, layer));
  symlinkSync(ids.dir, path.join(scene, "ID"));
}

/**
 * The compare rows of one capture folder at one layer, against the committed Unreal statistics. A capture with no
 * ID frames, such as the L9 frames of the preview loop, takes the committed Unreal ones for its masks, so its overlap
 * is not measured: every row has `iou: null`.
 */
export function compareCapture(scene: string, layer: string, run: string): IMeasuredRow[] {
  const key = sceneKey(scene);
  const own = existsSync(path.join(run, key, "ID"));
  const rows = withOfflineRoot(
    run,
    (root) => compareGiToUnreal(scene, [layer], root),
    own ? undefined : { key, dir: path.join(sceneDir(scene), "id") },
  );
  return own ? rows : rows.map((row) => ({ ...row, iou: null }));
}

export interface ICheckDeps {
  /** The compare rows of one capture folder at one layer, against the committed Unreal statistics. */
  compare(scene: string, layer: string, run: string): readonly IMeasuredRow[];
  /** The digest of the committed scene and Unreal reference (sceneBasis). */
  basis(scene: string): string;
  log(line: string): void;
  error(line: string): void;
}
export const defaultCheckDeps: ICheckDeps = {
  compare: compareCapture,
  basis: (scene) => sceneBasis(scene),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg !== name) return;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--"))
      fail("BAD_INPUT", `missing value for ${name}`);
    values.push(value);
  });
  return values;
}

const namesGiScene = (args: readonly string[]) =>
  args.some((arg, i) => arg === "--scene" && args[i + 1]?.startsWith("gi:"));

/** `--check` with one GI scene is the lock check. `--check` alone is the reference scene's, and `--scene gi` is the GI report. */
export const isGiCheck = (args: readonly string[]) =>
  args.includes("--check") && namesGiScene(args);

/** `--write-locks` with one GI scene cuts GI locks. `--write-locks` alone seeds the reference scene's. */
export const isGiLock = (args: readonly string[]) =>
  args.includes("--write-locks") && namesGiScene(args);

/** The lock key of an off-parity region named `<scene>/<pose> <region>`. */
const offKey = (scene: string, layer: string, name: string) =>
  `${scene} ${layer} ${name.slice(scene.length + 1)}`;

/** `compare --check --scene gi:<name> --captures <run1> --captures <run2> [--layer L7-high] [--locks <file>]`. */
export function checkCommand(args: readonly string[], deps: ICheckDeps = defaultCheckDeps): number {
  const [scene] = flagValues(args, "--scene").map((value) => value.replace(/^gi:/, ""));
  if (scene === undefined) fail("BAD_INPUT", "--check with --scene needs one scene: gi:<name>");
  const captures = flagValues(args, "--captures");
  if (captures.length < 1)
    fail("TOO_FEW_RUNS", "no --captures folder: pass the runs of the capture");
  const locks = readGiLocks(flagValues(args, "--locks")[0] ?? GI_LOCK_FILE);
  let broken = 0;
  for (const layer of layersToCheck(args, locks, scene)) {
    const { failures, runs } = checkLayer(scene, layer, captures, locks, deps);
    for (const failure of failures) deps.error(`GI LOCK BROKEN ${failure}`);
    broken += failures.length;
    const locked = locks.filter((lock) => lock.scene === scene && lock.layer === layer).length;
    deps.log(
      `${scene} ${layer}: ${locked} locked region(s) on ${captures.length} run${captures.length === 1 ? "" : "s"}, ${failures.length === 0 ? "every bound holds" : `${failures.length} bound(s) broken`}`,
    );
    if (runs.length > 0) deps.log(`${scene} ${layer}: ${distanceToUnreal(runs)}`);
  }
  return broken === 0 ? 0 : 1;
}

/** The layers a check covers: the ones `--layer` names, or every layer that the scene has locks at. */
function layersToCheck(
  args: readonly string[],
  locks: readonly IGiLock[],
  scene: string,
): string[] {
  const named = flagValues(args, "--layer").flatMap((value) => value.split(","));
  const wanted =
    named.length > 0
      ? named
      : [...new Set(locks.filter((l) => l.scene === scene).map((l) => l.layer))];
  if (wanted.length === 0)
    fail(
      "NO_LOCKS",
      `no lock for ${scene}: approve a round with pnpm unreal-look:calibrate --lock <round>`,
    );
  return wanted;
}

/**
 * The total distance to Unreal of a layer: dP50 and deltaE summed over every measured region, each the mean of the
 * runs, and the regions at parity in every run. Compare two prints to see whether a change is net closer.
 */
export function distanceToUnreal(runs: readonly (readonly IMeasuredRow[])[]): string {
  const maps = runs.map(index);
  const mean = (key: string, metric: "dP50" | "deltaE") => {
    const values = maps.map((map) => map.get(key)?.[metric]).filter(Number.isFinite) as number[];
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  };
  const keys = [...(maps[0]?.keys() ?? [])];
  const sum = (metric: "dP50" | "deltaE") => keys.reduce((a, key) => a + mean(key, metric), 0);
  const atParity = keys.filter((key) => maps.every((map) => map.get(key)?.pass === true)).length;
  return `distance to Unreal dP50 ${sum("dP50").toFixed(4)}, deltaE ${sum("deltaE").toFixed(2)} over ${keys.length} region(s), ${atParity} at parity`;
}

/** The broken bounds of one layer, one line each, and the runs it read. A check that cannot run is one broken line. */
function checkLayer(
  scene: string,
  layer: string,
  captures: readonly string[],
  locks: readonly IGiLock[],
  deps: ICheckDeps,
): { failures: string[]; runs: IMeasuredRow[][] } {
  const own = locks.filter((lock) => lock.scene === scene && lock.layer === layer);
  const need = own.length > 0 ? runsNeeded(own) : 1;
  if (captures.length < need)
    fail(
      "TOO_FEW_RUNS",
      `${captures.length} --captures folder(s): the locks of ${scene} at ${layer} were cut from ${need}, so pass as many captures`,
    );
  try {
    const runs = captures.map((run) => [...deps.compare(scene, layer, run)]);
    return { failures: checkGiLocks(scene, layer, runs, locks, deps.basis(scene)), runs };
  } catch (error) {
    return { failures: [(error as Error).message], runs: [] };
  }
}

/**
 * `compare --write-locks <head> --scene gi:<name> --layer <layer> --captures <run> [--captures <run>]
 * [--noise <run>,<run>]... [--tighten | --relax] [--locks <file>]`: cut the locks of one layer from the frames of an
 * approved capture. `<head>` names the capture (the head that took it) and the lock records it as its round. One
 * capture takes its noise from the pairs of runs named by `--noise`. No GPU and no model.
 */
export function lockCommand(args: readonly string[], deps: ICheckDeps = defaultCheckDeps): number {
  const [head] = flagValues(args, "--write-locks");
  const [scene] = flagValues(args, "--scene").map((value) => value.replace(/^gi:/, ""));
  if (head === undefined || scene === undefined)
    fail("BAD_INPUT", "--write-locks <head> needs one scene: --scene gi:<name>");
  const layers = flagValues(args, "--layer").flatMap((value) => value.split(","));
  const [layer] = layers;
  if (layer === undefined || layers.length !== 1)
    fail("BAD_INPUT", "--write-locks cuts one layer: pass --layer <layer>");
  if (args.includes("--tighten") && args.includes("--relax"))
    fail("BAD_INPUT", "--tighten and --relax exclude each other");
  const rowsOf = (run: string) => [...deps.compare(scene, layer, run)];
  const captured = flagValues(args, "--captures").map(rowsOf);
  // A lock exists only where the region is at parity with Unreal; --keep-off-parity cuts them all.
  const split = args.includes("--keep-off-parity")
    ? { runs: captured, off: [] as string[] }
    : splitParity(captured);
  if (split.runs[0]?.length === 0)
    fail(
      "NO_PARITY",
      `${scene} ${layer}: no region is at parity with Unreal, so nothing can be locked`,
    );
  const fresh = lockCells(
    head,
    scene,
    layer,
    split.runs,
    deps.basis(scene),
    flagValues(args, "--noise").map((pair) => pair.split(",").map(rowsOf)),
  );
  writeMerged(
    path.resolve(flagValues(args, "--locks")[0] ?? GI_LOCK_FILE),
    fresh,
    { tighten: args.includes("--tighten"), relax: args.includes("--relax") },
    deps.log,
    `${scene} ${layer} from ${head}`,
    new Set(split.off.map((name) => offKey(scene, layer, name))),
  );
  return 0;
}

/** The exit code of `compare --check --scene gi:<name>` and `compare --write-locks <head> --scene gi:<name>`, and undefined for any other command. */
export function giCommand(args: readonly string[]): number | undefined {
  if (isGiCheck(args)) return checkCommand(args);
  if (isGiLock(args)) return lockCommand(args);
  return undefined;
}
