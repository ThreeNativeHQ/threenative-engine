/**
 * Ratchet locks for the GI calibration scenes (PRD-653). An approved round (PRD-647) becomes a floor under
 * its regions, so that no later change makes them worse without anyone seeing it:
 *
 *   pnpm unreal-look:calibrate --lock <round> [--tighten | --relax]    write tools/unreal-reference/gi/parity-locks.json
 *   pnpm unreal-look:compare --check --scene gi:<name> --captures <run1> --captures <run2> [--layer L7-high]
 *
 * A lock holds, per scene, layer, pose and region, the worst dP50 and deltaE and the lowest ID overlap of the
 * round. Each bound is widened by the run-to-run noise that the two runs of the round measured, and the two
 * color bounds by one display level of the reference median, the smallest step the metric can take. The check
 * fails when a region of a new capture is past its bound, when a locked region or a run is missing, and when
 * the two runs of the new capture differ by more than the locked noise. A lock tightens only on request
 * (--tighten) and loosens only on request (--relax). Every comparison reads the committed Unreal statistics
 * (reference-stats.json), so the check needs no Unreal capture.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IRow, ciede2000, lab } from "./compare.js";
import { compareGiToUnreal } from "./gi.js";

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
};

export interface IGiLock {
  scene: string;
  layer: string;
  pose: string;
  region: string;
  /** The approved round that cut the lock. */
  round: string;
  maxDP50: number;
  maxDeltaE: number;
  minIoU: number;
  /** Spread of each metric between the two runs of that round. */
  noiseDP50: number;
  noiseDeltaE: number;
  noiseIoU: number;
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

export const lockKey = (lock: Pick<IGiLock, "scene" | "layer" | "pose" | "region">) =>
  `${lock.scene} ${lock.layer} ${lock.pose} ${lock.region}`;
const rowKey = (row: Pick<IMeasuredRow, "cell" | "region">) => `${row.cell}\u0000${row.region}`;
const show = (value: number) => Number(value.toPrecision(4));

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

/** The locks that two runs of an approved round make, one per region of each pose. */
export function lockCells(
  round: string,
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
): IGiLock[] {
  if (runs.length < 2)
    fail(
      "TOO_FEW_RUNS",
      `${runs.length} run(s): a lock is cut from two runs, so that its noise is measured`,
    );
  const maps = runs.map((rows) => new Map(rows.map((row) => [rowKey(row), row] as const)));
  const [first] = maps as [Map<string, IMeasuredRow>];
  for (const map of maps)
    if (map.size !== first.size || [...map.keys()].some((key) => !first.has(key)))
      fail("RUN_MISMATCH", "the runs do not measure the same regions of the same poses");
  if (first.size === 0) fail("RUN_MISMATCH", `${scene} ${layer}: the runs measure no region`);
  return [...first.values()].map((row) => {
    if (!row.cell.startsWith(`${scene}/`))
      fail("BAD_INPUT", `${row.cell} is not a cell of the scene ${scene}`);
    const at = maps.map((map) => map.get(rowKey(row)) as IMeasuredRow);
    const step = displayLevel(row.unreal?.p50);
    const lock: Record<string, string | number> = {
      scene,
      layer,
      pose: row.cell.slice(scene.length + 1),
      region: row.region,
      round,
    };
    for (const metric of METRICS) {
      const values = at.map((r) =>
        finite(r[metric.name], `${row.cell}/${row.region} ${metric.name}`),
      );
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const noise = Math.max(...values) - Math.min(...values);
      const level = metric.name === "iou" ? 0 : step[metric.name];
      lock[metric.limit] = metric.floor
        ? Math.max(significant(mean - noise, "down"), 0)
        : significant(mean + noise + level, "up");
      lock[metric.noise] = significant(noise, "up");
    }
    return lock as unknown as IGiLock;
  });
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
}

/**
 * The lock file after a round. A cell that no lock covers is added. A cell that a lock covers keeps its
 * bounds, unless the round is tighter and `tighten` says so, or looser and `relax` says so. A round that
 * no longer measures a cell that its scene and layer have locked is refused: no round drops a cell.
 */
export function mergeLocks(
  existing: readonly IGiLock[],
  fresh: readonly IGiLock[],
  mode: { tighten?: boolean; relax?: boolean } = {},
): IMerge {
  const old = new Map(existing.map((lock) => [lockKey(lock), lock] as const));
  const next = new Map(old);
  const out: IMerge = { locks: [], added: [], moved: [], improved: [], looser: [] };
  for (const lock of fresh) {
    const key = lockKey(lock);
    const was = old.get(key);
    if (was === undefined) {
      next.set(key, lock);
      out.added.push(key);
      continue;
    }
    const { better, looser } = compareBounds(was, lock, key);
    out.looser.push(...looser);
    if (looser.length > 0 ? mode.relax : better && mode.tighten) {
      next.set(key, lock);
      out.moved.push(key);
    } else if (looser.length === 0 && better) out.improved.push(key);
  }
  refuseDropped(existing, fresh);
  if (!mode.relax) refuseLooser(out.looser);
  out.locks = [...next.values()];
  return out;
}

/** A round that is looser than a lock on any bound is a regression: it is refused unless --relax accepts it. */
function refuseLooser(looser: readonly string[]): void {
  if (looser.length > 0)
    fail(
      "LOCK_LOOSER",
      `the round is looser than the lock on ${looser.length} bound(s): ${looser.slice(0, 5).join("; ")}${looser.length > 5 ? "; ..." : ""}. Fix the regression, or pass --relax to accept it on purpose`,
    );
}

/** How a fresh lock stands against the stored one: tighter on some bound, and the bounds on which it is looser. */
function compareBounds(
  was: IGiLock,
  lock: IGiLock,
  key: string,
): { better: boolean; looser: string[] } {
  let better = false;
  const looser: string[] = [];
  for (const metric of METRICS) {
    const tolerance = SAME * Math.abs(was[metric.limit]);
    for (const field of [metric.limit, metric.noise] as const) {
      // A larger noise allows more, so it counts like a ceiling.
      const tighter =
        metric.floor && field === metric.limit
          ? lock[field] - was[field]
          : was[field] - lock[field];
      if (tighter > tolerance) better = true;
      else if (tighter < -tolerance)
        looser.push(`${key} ${field}: ${was[field]} -> ${lock[field]}`);
    }
  }
  return { better, looser };
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

/** The ways a capture breaks the locks of one scene and layer, one line each. Throws when it cannot check. */
export function checkGiLocks(
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  locks: readonly IGiLock[],
): string[] {
  const own = locks.filter((lock) => lock.scene === scene && lock.layer === layer);
  if (own.length === 0)
    fail(
      "NO_LOCKS",
      `no lock for ${scene} at ${layer}: approve a round with pnpm unreal-look:calibrate --lock <round>`,
    );
  if (runs.length < 2)
    fail(
      "TOO_FEW_RUNS",
      `${runs.length} run(s): the check reads two captures, so that it sees their noise`,
    );
  const maps = runs.map((rows) => new Map(rows.map((row) => [rowKey(row), row] as const)));
  const failures: string[] = [];
  for (const lock of own) {
    const name = lockKey(lock);
    const found = maps.map((map) =>
      map.get(rowKey({ cell: `${lock.scene}/${lock.pose}`, region: lock.region })),
    );
    const absent = found.flatMap((row, i) => (row === undefined ? [i + 1] : []));
    if (absent.length > 0) {
      failures.push(
        `${name}: missing from run ${absent.join(" and run ")} (locked by round ${lock.round})`,
      );
      continue;
    }
    for (const metric of METRICS) {
      const limit = lock[metric.limit];
      const values = found.map((row) => (row as IMeasuredRow)[metric.name]);
      if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        failures.push(`${name} ${metric.name}: a run gave no value`);
        continue;
      }
      const numbers = values as number[];
      numbers.forEach((value, i) => {
        if (metric.floor ? value < limit * (1 - SAME) : value > limit * (1 + SAME))
          failures.push(
            `${name} ${metric.name}: ${show(value)} is ${metric.floor ? "below" : "above"} the lock ${limit} in run ${i + 1} (round ${lock.round})`,
          );
      });
      const spread = Math.max(...numbers) - Math.min(...numbers);
      if (spread > lock[metric.noise] + AGREE * Math.abs(limit))
        failures.push(
          `${name} ${metric.name}: the runs differ by ${show(spread)}, more than the locked noise ${lock[metric.noise]}`,
        );
    }
  }
  return failures;
}

const METRIC_FIELDS = METRICS.flatMap((metric) => [metric.limit, metric.noise]);

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
    const lock = (raw ?? {}) as Record<string, unknown>;
    for (const field of ["scene", "layer", "pose", "region", "round"])
      if (typeof lock[field] !== "string" || lock[field] === "")
        fail("BAD_INPUT", `${file} lock ${index}: ${field} must be a non-empty string`);
    for (const field of METRIC_FIELDS)
      if (
        typeof lock[field] !== "number" ||
        !Number.isFinite(lock[field]) ||
        (lock[field] as number) < 0
      )
        fail("BAD_INPUT", `${file} lock ${index}: ${field} must be a non-negative number`);
    const typed = lock as unknown as IGiLock;
    if (keys.has(lockKey(typed))) fail("BAD_INPUT", `${file}: ${lockKey(typed)} is locked twice`);
    keys.add(lockKey(typed));
    return Object.fromEntries(
      ["scene", "layer", "pose", "region", "round", ...METRIC_FIELDS].map((field) => [
        field,
        lock[field],
      ]),
    ) as unknown as IGiLock;
  });
}

export function writeGiLocks(file: string, locks: readonly IGiLock[]): void {
  writeFileSync(file, `${JSON.stringify({ version: 1, locks }, null, 2)}\n`);
}

/**
 * Run `use` on a compare root that holds one capture folder as its ThreeNative side and no Unreal frames.
 * An error that names a file under that root names the capture folder instead.
 */
export function withOfflineRoot<T>(run: string, use: (root: string) => T): T {
  if (!existsSync(run)) fail("MISSING_CELL", `${run} is not a capture folder`);
  const root = mkdtempSync(path.join(os.tmpdir(), "gi-lock-"));
  const folder = path.resolve(run);
  try {
    symlinkSync(folder, path.join(root, "threenative"));
    return use(root);
  } catch (error) {
    if (error instanceof Error)
      error.message = error.message.replaceAll(path.join(root, "threenative"), folder);
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface ICheckDeps {
  /** The compare rows of one capture folder at one layer, against the committed Unreal statistics. */
  compare(scene: string, layer: string, run: string): readonly IMeasuredRow[];
  log(line: string): void;
  error(line: string): void;
}
export const defaultCheckDeps: ICheckDeps = {
  compare: (scene, layer, run) =>
    withOfflineRoot(run, (root) => compareGiToUnreal(scene, [layer], root)),
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

/** `--check` with one GI scene is the lock check. `--check` alone is the reference scene's, and `--scene gi` is the GI report. */
export const isGiCheck = (args: readonly string[]) =>
  args.includes("--check") &&
  args.some((arg, i) => arg === "--scene" && args[i + 1]?.startsWith("gi:"));

/** `compare --check --scene gi:<name> --captures <run1> --captures <run2> [--layer L7-high] [--locks <file>]`. */
export function checkCommand(args: readonly string[], deps: ICheckDeps = defaultCheckDeps): number {
  const [scene] = flagValues(args, "--scene").map((value) => value.replace(/^gi:/, ""));
  if (scene === undefined) fail("BAD_INPUT", "--check with --scene needs one scene: gi:<name>");
  const captures = flagValues(args, "--captures");
  if (captures.length < 2)
    fail(
      "TOO_FEW_RUNS",
      `${captures.length} --captures folder(s): pass the two runs of the capture`,
    );
  const locks = readGiLocks(flagValues(args, "--locks")[0] ?? GI_LOCK_FILE);
  const layers = flagValues(args, "--layer").flatMap((value) => value.split(","));
  const wanted =
    layers.length > 0
      ? layers
      : [...new Set(locks.filter((l) => l.scene === scene).map((l) => l.layer))];
  if (wanted.length === 0)
    fail(
      "NO_LOCKS",
      `no lock for ${scene}: approve a round with pnpm unreal-look:calibrate --lock <round>`,
    );
  let broken = 0;
  for (const layer of wanted) {
    const own = locks.filter((lock) => lock.scene === scene && lock.layer === layer);
    let failures: string[];
    try {
      failures = checkGiLocks(
        scene,
        layer,
        captures.map((run) => [...deps.compare(scene, layer, run)]),
        locks,
      );
    } catch (error) {
      failures = [(error as Error).message];
    }
    for (const failure of failures) deps.error(`GI LOCK BROKEN ${failure}`);
    broken += failures.length;
    deps.log(
      `${scene} ${layer}: ${own.length} locked region(s) on ${captures.length} runs, ${failures.length === 0 ? "every bound holds" : `${failures.length} bound(s) broken`}`,
    );
  }
  return broken === 0 ? 0 : 1;
}
