/**
 * No-regress ratchets (owner order 2026-10-22: no whack-a-mole). A parity lock bounds a region that matches
 * Unreal. A ratchet bounds a region that does not match yet: its distance to Unreal may shrink, but it may not
 * grow. The two stay apart, so that a parity lock still means parity.
 *
 *   pnpm unreal-look:ratchet --cut <sha> --scene reference|gi:<name> --layer <layer>[,...] --captures <run> --captures <run>...
 *   pnpm unreal-look:compare --check ...     fails on a broken ratchet as on a broken parity lock
 *
 * A ratchet holds one metric (dP50, deltaE or ID overlap) of one region of one pose at one layer, for each
 * metric that no parity lock covers. Its bound is the worst value of the runs that cut it, plus their spread
 * (at least one display level of the Unreal median), in the direction away from Unreal. A cut only tightens:
 * a bound moves toward Unreal when the new runs are closer, and a region that gains a parity lock leaves the
 * file. `--relax --reason "<text>"` lets one cut move bounds away from Unreal, and records the reason. A cut
 * that no longer measures a ratcheted region is refused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type IGiLock, type IMeasuredRow, displayLevel, significant } from "./giLocks.js";

export const RATCHET_FILE = path.resolve(
  import.meta.dirname,
  "../../tools/unreal-reference/ratchets.json",
);
/** The scene name of the PRD-631 reference scene (spheres, exterior, interior, backlit). */
export const REFERENCE_SCENE = "reference";
const METRICS = ["dP50", "deltaE", "iou"] as const;
export type RatchetMetric = (typeof METRICS)[number];
/** The smallest spread of an ID overlap: one pixel in about ten thousand. */
const IOU_STEP = 1e-4;

export interface IRatchet {
  scene: string;
  layer: string;
  /** The compare row's cell: `sun60_exterior` on the reference scene, `<scene>/<pose>` on a GI scene. */
  cell: string;
  region: string;
  metric: RatchetMetric;
  /** The value that may not be passed: larger is further from Unreal, except for `iou`. */
  bound: number;
  /** The worst value of the runs that cut the ratchet, and their spread. */
  value: number;
  spread: number;
  runs: number;
  /** The commit whose captures cut the ratchet, and the day. */
  since: string;
  date: string;
  /** sceneBasis of a GI scene at the cut: a rebuilt scene makes the ratchet stale. */
  basis?: string;
  /** Why a `--relax` cut moved the bound away from Unreal. */
  reason?: string;
}

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}
const show = (value: number) => Number(value.toPrecision(4));
const worse = (metric: RatchetMetric, a: number, b: number) => (metric === "iou" ? a < b : a > b);
export const ratchetKey = (r: Pick<IRatchet, "scene" | "layer" | "cell" | "region" | "metric">) =>
  `${r.scene} ${r.layer} ${r.cell} ${r.region} ${r.metric}`;

export function readRatchets(file = RATCHET_FILE): IRatchet[] {
  if (!existsSync(file)) fail("BAD_INPUT", `${file}: no ratchet file`);
  const data = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; ratchets?: unknown };
  if (data.version !== 1 || !Array.isArray(data.ratchets))
    fail("BAD_INPUT", `${file}: expected {"version": 1, "ratchets": [...]}`);
  const seen = new Set<string>();
  return data.ratchets.map((raw: unknown, i: number) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    for (const field of ["scene", "layer", "cell", "region", "since", "date"])
      if (typeof r[field] !== "string" || r[field] === "")
        fail("BAD_INPUT", `${file} ratchet ${i}: ${field} must be a non-empty string`);
    if (!METRICS.includes(r.metric as RatchetMetric))
      fail("BAD_INPUT", `${file} ratchet ${i}: unknown metric ${String(r.metric)}`);
    for (const field of ["bound", "value", "spread", "runs"])
      if (typeof r[field] !== "number" || !Number.isFinite(r[field]) || (r[field] as number) < 0)
        fail("BAD_INPUT", `${file} ratchet ${i}: ${field} must be a non-negative number`);
    const ratchet = r as unknown as IRatchet;
    if (seen.has(ratchetKey(ratchet)))
      fail("BAD_INPUT", `${file}: ${ratchetKey(ratchet)} is ratcheted twice`);
    seen.add(ratchetKey(ratchet));
    return ratchet;
  });
}

export function writeRatchets(file: string, ratchets: readonly IRatchet[]): void {
  const sorted = [...ratchets].sort((a, b) => ratchetKey(a).localeCompare(ratchetKey(b)));
  writeFileSync(file, `${JSON.stringify({ version: 1, ratchets: sorted }, null, 2)}\n`);
}

/** Whether a parity lock already bounds this metric of this row: then no ratchet is cut for it. */
export type Covered = (row: IMeasuredRow, metric: RatchetMetric) => boolean;

/** A metric of a reference-scene row is covered when parity-locks.json locks that cell, region and metric. */
export const referenceCovered =
  (
    layer: string,
    locks: readonly { layer: string; sun: string; pose: string; region: string; metric: string }[],
  ): Covered =>
  (row, metric) =>
    locks.some(
      (l) =>
        l.layer === layer &&
        `${l.sun}_${l.pose}` === row.cell &&
        l.region === row.region &&
        l.metric === metric,
    );

/** A GI lock bounds dP50 and deltaE of its region, and the overlap when it has an overlap bound. */
export const giCovered =
  (scene: string, layer: string, locks: readonly IGiLock[]): Covered =>
  (row, metric) =>
    locks.some(
      (l) =>
        l.scene === scene &&
        l.layer === layer &&
        `${l.scene}/${l.pose}` === row.cell &&
        l.region === row.region &&
        (metric !== "iou" || l.minIoU !== undefined),
    );

/**
 * The ratchets that the runs of one capture cut: one per region and metric that every run measures and that no
 * parity lock covers. The bound is rounded away from Unreal, so the runs that cut it always hold.
 */
export function cutRatchets(
  cut: { scene: string; layer: string; since: string; date: string; basis?: string },
  runs: readonly (readonly IMeasuredRow[])[],
  covered: Covered,
): IRatchet[] {
  if (runs.length < 2)
    fail(
      "TOO_FEW_RUNS",
      `${runs.length} run(s): a ratchet is cut from at least two runs, so that its spread is measured`,
    );
  const [first = []] = runs;
  const find = (run: readonly IMeasuredRow[], row: IMeasuredRow) =>
    run.find((r) => r.cell === row.cell && r.region === row.region);
  const out: IRatchet[] = [];
  for (const row of first)
    for (const metric of METRICS) {
      if (covered(row, metric)) continue;
      const values = runs.map((run) => find(run, row)?.[metric]);
      if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
      const numbers = values as number[];
      const value = metric === "iou" ? Math.min(...numbers) : Math.max(...numbers);
      const step = metric === "iou" ? IOU_STEP : displayLevel(row.unreal?.p50)[metric];
      const spread = Math.max(Math.max(...numbers) - Math.min(...numbers), step);
      const bound =
        metric === "iou"
          ? Math.max(significant(value - spread, "down"), 0)
          : significant(value + spread, "up");
      out.push({
        scene: cut.scene,
        layer: cut.layer,
        cell: row.cell,
        region: row.region,
        metric,
        bound,
        value: show(value),
        spread: significant(spread, "up"),
        runs: runs.length,
        since: cut.since,
        date: cut.date,
        ...(cut.basis === undefined ? {} : { basis: cut.basis }),
      });
    }
  return out;
}

/**
 * The ways the runs of one scene and layer break its ratchets, one line each. Every run is read: a run that is
 * further from Unreal than the bound breaks it, and a ratcheted region that a run does not measure fails closed.
 * `cells` limits the check to the cells that the capture was asked for (the suns of a partial reference check).
 */
export function checkRatchets(
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  ratchets: readonly IRatchet[],
  options: { basis?: string; cells?: (cell: string) => boolean } = {},
): string[] {
  const own = ratchets.filter(
    (r) => r.scene === scene && r.layer === layer && (options.cells?.(r.cell) ?? true),
  );
  const failures: string[] = [];
  for (const ratchet of own) {
    const name = ratchetKey(ratchet);
    if (
      options.basis !== undefined &&
      ratchet.basis !== undefined &&
      ratchet.basis !== options.basis
    ) {
      failures.push(
        `${name}: cut against another scene or Unreal reference (${ratchet.basis}, now ${options.basis}); cut it again`,
      );
      continue;
    }
    runs.forEach((run, i) => {
      const value = run.find((r) => r.cell === ratchet.cell && r.region === ratchet.region)?.[
        ratchet.metric
      ];
      if (typeof value !== "number" || !Number.isFinite(value))
        failures.push(`${name}: missing from run ${i + 1} (ratcheted at ${ratchet.since})`);
      else if (worse(ratchet.metric, value, ratchet.bound))
        failures.push(
          `${name}: ${show(value)} in run ${i + 1} is further from Unreal than the ratchet ${ratchet.bound} (cut at ${ratchet.since}, value ${ratchet.value})`,
        );
    });
  }
  return failures;
}

/**
 * The ratchet file after a cut of one scene and layer. A fresh bound that is closer to Unreal replaces the stored
 * one; a looser one keeps the stored one, unless `relax` names a reason. A stored ratchet that the cut does not
 * measure is removed when a parity lock now covers it, and refused otherwise.
 */
export function mergeRatchets(
  stored: readonly IRatchet[],
  fresh: readonly IRatchet[],
  scope: { scene: string; layer: string; covered: (r: IRatchet) => boolean },
  relax?: string,
): {
  ratchets: IRatchet[];
  tightened: string[];
  looser: string[];
  added: string[];
  parity: string[];
} {
  const inScope = (r: IRatchet) => r.scene === scope.scene && r.layer === scope.layer;
  const old = new Map(stored.filter(inScope).map((r) => [ratchetKey(r), r] as const));
  const out = {
    tightened: [] as string[],
    looser: [] as string[],
    added: [] as string[],
    parity: [] as string[],
  };
  const kept: IRatchet[] = stored.filter((r) => !inScope(r));
  for (const ratchet of fresh) {
    const key = ratchetKey(ratchet);
    const was = old.get(key);
    old.delete(key);
    if (was === undefined) {
      out.added.push(key);
      kept.push(ratchet);
    } else if (was.basis !== ratchet.basis || worse(ratchet.metric, ratchet.bound, was.bound)) {
      out.looser.push(`${key}: ${was.bound} -> ${ratchet.bound}`);
      kept.push(relax === undefined ? was : { ...ratchet, reason: relax });
    } else if (ratchet.bound !== was.bound) {
      out.tightened.push(`${key}: ${was.bound} -> ${ratchet.bound}`);
      kept.push(ratchet);
    } else kept.push(was);
  }
  const dropped = [...old.values()].filter((r) => !scope.covered(r));
  if (dropped.length > 0)
    fail(
      "RATCHET_DROPPED",
      `the cut no longer measures ${dropped.length} ratcheted region(s): ${dropped.slice(0, 5).map(ratchetKey).join("; ")}${dropped.length > 5 ? "; ..." : ""}`,
    );
  out.parity.push(...[...old.keys()]);
  if (out.looser.length > 0 && relax === undefined)
    fail(
      "RATCHET_LOOSER",
      `the cut is further from Unreal than ${out.looser.length} ratchet(s): ${out.looser.slice(0, 5).join("; ")}${out.looser.length > 5 ? "; ..." : ""}. Fix the regression, or pass --relax --reason "<why>"`,
    );
  return { ratchets: kept, ...out };
}

function flagValues(args: readonly string[], name: string): string[] {
  return args.flatMap((arg, i) => {
    if (arg !== name) return [];
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--"))
      fail("BAD_INPUT", `missing value for ${name}`);
    return [value];
  });
}

/** `--cut <sha> --scene reference|gi:<name> --layer <layer>[,...] --captures <run>... [--ratchets <file>] [--relax --reason <text>]`. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  const [since] = flagValues(args, "--cut");
  const [sceneArg] = flagValues(args, "--scene");
  const layers = flagValues(args, "--layer").flatMap((v) => v.split(","));
  const captures = flagValues(args, "--captures");
  const file = path.resolve(flagValues(args, "--ratchets")[0] ?? RATCHET_FILE);
  const relax = args.includes("--relax") ? flagValues(args, "--reason")[0] : undefined;
  if (args.includes("--relax") && !relax) fail("BAD_INPUT", "--relax needs --reason <why>");
  if (!since || !sceneArg || layers.length === 0)
    fail(
      "BAD_INPUT",
      "usage: --cut <sha> --scene reference|gi:<name> --layer <layer> --captures <run> --captures <run>",
    );
  const { GI_LOCK_FILE, compareCapture, readGiLocks, sceneBasis } = await import("./giLocks.js");
  const { readLocks, runComparison } = await import("./compare.js");
  const date = new Date().toISOString().slice(0, 10);
  let ratchets = existsSync(file) ? readRatchets(file) : [];
  for (const layer of layers) {
    let runs: IMeasuredRow[][];
    let covered: Covered;
    let basis: string | undefined;
    let scene: string;
    if (sceneArg === REFERENCE_SCENE) {
      scene = REFERENCE_SCENE;
      const dir = flagValues(args, "--reference-dir")[0] ?? "tools/unreal-reference";
      runs = captures.map((run) =>
        runComparison({ referenceDir: dir, threenative: run, layers: [layer] }).rows.filter(
          (row) => row.layer === layer,
        ),
      );
      covered = referenceCovered(layer, readLocks(path.join(dir, "parity-locks.json")));
    } else {
      scene = sceneArg.replace(/^gi:/, "");
      runs = captures.map((run) => [...compareCapture(scene, layer, run)]);
      covered = giCovered(scene, layer, readGiLocks(GI_LOCK_FILE));
      basis = sceneBasis(scene);
    }
    const fresh = cutRatchets({ scene, layer, since, date, basis }, runs, covered);
    const rows = new Map(runs[0]?.map((row) => [`${row.cell} ${row.region}`, row]));
    const merged = mergeRatchets(
      ratchets,
      fresh,
      {
        scene,
        layer,
        covered: (r) => {
          const row = rows.get(`${r.cell} ${r.region}`);
          return row !== undefined && covered(row, r.metric);
        },
      },
      relax,
    );
    ratchets = merged.ratchets;
    console.log(
      `${scene} ${layer}: ${fresh.length} ratchet(s) from ${captures.length} runs at ${since}; ${merged.added.length} added, ${merged.tightened.length} tightened, ${merged.parity.length} left for a parity lock${relax ? `, ${merged.looser.length} relaxed (${relax})` : ""}`,
    );
    for (const line of merged.tightened) console.log(`  tightened ${line}`);
    for (const line of merged.looser) console.log(`  relaxed ${line}`);
  }
  writeRatchets(file, ratchets);
  console.log(`wrote ${file} (${ratchets.length} ratchet(s))`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
