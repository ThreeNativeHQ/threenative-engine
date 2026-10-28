/**
 * `pnpm unreal-look:calibrate` — one PRD-647 calibration round on a GI calibration scene.
 *
 *   pnpm unreal-look:calibrate --scene gi:cornell --tier high --before HEAD --unreal <Unreal tree>
 *     --before <commit>           the BEFORE arm: a commit whose arm is in the store (HEAD with a clean
 *                                 tree is the AFTER arm itself, which is the baseline round)
 *     --unreal <dir>              the Unreal capture tree (<scene>/<ID|L1|L7-Epic|...>/<pose>.png)
 *     --runs 2                    captures per arm (the visual judge rule asks for two or more)
 *     --expect improvement        the change promises an improvement (exit 2 without one)
 *     --capture-only              capture this tree's arm into the store and stop
 *     --allow-red-direct-light    run although the L1 (GI off) cells miss the thresholds (PRD-646)
 *     --dry-run                   check the inputs and print the plan
 *     --store <dir>               arms and rounds (default $TN_UNREAL_LOOK_ROUNDS)
 *     --scoreboard <dir>          default tools/unreal-reference/gi/parity
 *   pnpm unreal-look:calibrate --status [--scene gi:<name>] [--tier <tier>] [--scoreboard <dir>]
 *                                 where each scene stands: its latest round, gap list and parity (no GPU)
 *
 * Captures the ThreeNative cells (ID, L1 and the tier's L7 layer) once per run on the owned engine, keeps
 * them in the store under a stamp of everything that decides the pixels, so an arm is never captured
 * twice, compares them with Unreal numerically, lays out UNREAL | BEFORE | AFTER sheets, has a fresh
 * read-only judge answer two questions per cell (`unreal-look:judge`), appends the round to the
 * scoreboard and prints the gap list and the parity status. Every check fails closed.
 * $TN_UNREAL_LOOK_GPU_WRAPPER (for example `sh <slots>/gpu-slot.sh`) prefixes the capture command.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  GI_LAYER,
  type IArmRef,
  type IMeasured,
  type IRegion,
  type IRound,
  adapterName,
  averageRuns,
  buildRound,
  evaluate,
  fail,
  lightLimits,
  numbersTable,
  parity,
  readRounds,
  report,
  roundId,
  tierLayer,
} from "./calibrateRound.js";
import { compareGiToUnreal, readScene, readThresholds, registry } from "./gi.js";
import {
  GI_LOCK_FILE,
  checkGiLocks,
  lockCells,
  readGiLocks,
  sceneBasis,
  splitParity,
  staleLocks,
  withOfflineRoot,
  writeMerged,
} from "./giLocks.js";
import { main as judgeMain } from "./judge.js";
import { type Expect, type Tier, UNREAL_LEVEL } from "./judgeVerdict.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
const GI = path.join(REFERENCE, "gi");

const USAGE =
  "pnpm unreal-look:calibrate --scene gi:<name> --tier <low|medium|high> --before <commit> --unreal <dir> [--runs 2] [--expect improvement] [--capture-only] [--allow-red-direct-light] [--dry-run] [--store <dir>] [--scoreboard <dir>]\n  pnpm unreal-look:calibrate --status [--scene gi:<name>] [--tier <tier>] [--scoreboard <dir>]\n  pnpm unreal-look:calibrate --lock <round id> [--tighten | --relax] [--store <dir>] [--scoreboard <dir>] [--locks <file>]";

/** One captured arm of the store: the runs of one tree (stamp) at one scene and tier. */
export interface IArm {
  version: 1;
  stamp: string;
  commit: string;
  dirty: boolean;
  scene: string;
  tier: Tier;
  layers: string[];
  runs: string[];
  engine: string;
  adapter: string;
  capturedAt: string;
}
export interface IDeps {
  /** The layers the capture harness can draw (GI_LAYERS); a tier layer it lacks fails before any GPU time. */
  captureLayers(): Promise<readonly string[]>;
  /** The commit of the checkout, whether the pixel inputs differ from it, and a stamp over all of them. */
  state(scene: string): Promise<{ commit: string; dirty: boolean; stamp: string }>;
  resolve(ref: string): string;
  capture(job: { scene: string; layers: string[]; out: string }): Promise<void>;
  compare(scene: string, layer: string, root: string): IMeasured[];
  judge(args: string[]): Promise<number>;
  sheet(spec: string): Promise<void>;
  now(): Date;
  log(line: string): void;
}

interface IOptions {
  scene: string;
  tier: Tier;
  before?: string;
  unreal: string;
  runs: number;
  expect: Expect;
  captureOnly: boolean;
  allowRed: boolean;
  dryRun: boolean;
  store: string;
  scoreboard: string;
  /** The GI lock file (PRD-654) that the round checks its AFTER arm against. */
  locks: string;
}

function parse(args: string[]): IOptions {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        scene: { type: "string" },
        tier: { type: "string" },
        before: { type: "string" },
        unreal: { type: "string" },
        runs: { type: "string" },
        expect: { type: "string" },
        store: { type: "string" },
        scoreboard: { type: "string" },
        locks: { type: "string" },
        "capture-only": { type: "boolean" },
        "allow-red-direct-light": { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
    }).values;
  } catch (error) {
    return fail("BAD_INPUT", `${(error as Error).message}\n${USAGE}`);
  }
  const text = (name: string): string => {
    const value = values[name];
    return typeof value === "string" && value !== ""
      ? value
      : fail("BAD_INPUT", `--${name} is required\n${USAGE}`);
  };
  const scene = text("scene").replace(/^gi:/, "");
  if (!registry("gi").scenes.some((s) => s.name === scene))
    fail(
      "BAD_INPUT",
      `--scene ${scene} is not a GI calibration scene (tools/unreal-reference/gi/scenes.json)`,
    );
  const tier = text("tier");
  tierLayer(tier);
  const runs = Number(values.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 2)
    fail(
      "TOO_FEW_RUNS",
      `--runs ${String(values.runs)}: the visual judge rule asks for two or more captures per arm`,
    );
  const expect = String(values.expect ?? "preserve");
  if (expect !== "preserve" && expect !== "improvement")
    fail("BAD_INPUT", "--expect is preserve or improvement");
  const captureOnly = values["capture-only"] === true;
  if (!captureOnly) text("before");
  return {
    scene,
    tier: tier as Tier,
    ...(typeof values.before === "string" ? { before: values.before } : {}),
    unreal: path.resolve(String(values.unreal ?? path.join(REFERENCE, "captures/unreal"))),
    runs,
    expect,
    captureOnly,
    allowRed: values["allow-red-direct-light"] === true,
    dryRun: values["dry-run"] === true,
    store: path.resolve(
      String(
        values.store ??
          process.env.TN_UNREAL_LOOK_ROUNDS ??
          path.join(os.homedir(), ".cache/threenative/unreal-look-rounds"),
      ),
    ),
    scoreboard: path.resolve(String(values.scoreboard ?? path.join(GI, "parity"))),
    locks: path.resolve(String(values.locks ?? GI_LOCK_FILE)),
  };
}

const armDir = (store: string, stamp: string, scene: string, tier: Tier) =>
  path.join(store, "arms", stamp.slice(0, 12), scene, tier);

function readArm(dir: string): IArm | undefined {
  const file = path.join(dir, "arm.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as IArm) : undefined;
}

/** The newest clean arm of a commit: how a round finds its BEFORE. */
function findArm(
  store: string,
  scene: string,
  tier: Tier,
  commit: string,
): { arm: IArm; dir: string } {
  const root = path.join(store, "arms");
  const found = (existsSync(root) ? readdirSync(root) : [])
    .map((stamp) => path.join(root, stamp, scene, tier))
    .flatMap((dir) => {
      const arm = readArm(dir);
      return arm && arm.commit === commit && !arm.dirty ? [{ arm, dir }] : [];
    })
    .sort((a, b) => b.arm.capturedAt.localeCompare(a.arm.capturedAt));
  const [newest] = found;
  if (newest === undefined)
    return fail(
      "NO_BEFORE",
      `no ${tier} arm of ${scene} at commit ${commit.slice(0, 7)} in ${store}: check that commit out and run ` +
        `\`pnpm unreal-look:calibrate --scene gi:${scene} --tier ${tier} --capture-only\` there once`,
    );
  return newest;
}

const frame = (run: string, scene: string, layer: string, pose: string) =>
  path.join(run, scene, layer, `${pose}.png`);

/** The engine a capture reports for a layer: one `<scene>/<layer>` entry, or one per sun (`<scene>/<layer>/<sun>`). */
function enginesOf(info: Record<string, { engine?: string }>, scene: string, layer: string) {
  const own = `${scene}/${layer}`;
  return Object.entries(info)
    .filter(([key]) => key === own || key.startsWith(`${own}/`))
    .map(([, entry]) => entry.engine);
}

/** Every frame of a run must exist, and the run must name an engine and a GPU adapter. */
function verifyRun(
  run: string,
  scene: string,
  layers: string[],
  poses: string[],
): { engine: string; adapter: string } {
  const file = path.join(run, "gi-capture.json");
  if (!existsSync(file))
    fail("MISSING_CELL", `${run} has no gi-capture.json: the capture did not finish`);
  const info = JSON.parse(readFileSync(file, "utf8")) as Record<string, { engine?: string }>;
  const adapter = adapterName((info as Record<string, unknown>).adapter);
  for (const layer of layers) {
    const engines = layer === "ID" ? [] : enginesOf(info, scene, layer);
    if (layer !== "ID" && (engines.length === 0 || engines.some((e) => e !== "threenative")))
      fail(
        "WRONG_ENGINE",
        `${scene}/${layer} did not draw on the owned engine (engine ${engines.map(String).join(", ") || "undefined"})`,
      );
    for (const pose of poses)
      if (!existsSync(frame(run, scene, layer, pose)))
        fail("MISSING_CELL", `${frame(run, scene, layer, pose)}`);
  }
  return { engine: "threenative", adapter };
}

const verifies = (check: () => unknown): boolean => {
  try {
    check();
    return true;
  } catch {
    return false;
  }
};

async function ensureArm(
  deps: IDeps,
  o: IOptions,
  state: { commit: string; dirty: boolean; stamp: string },
  layers: string[],
  poses: string[],
): Promise<{ arm: IArm; dir: string; captured: boolean }> {
  const dir = armDir(o.store, state.stamp, o.scene, o.tier);
  const have = readArm(dir);
  if (have && layers.every((l) => have.layers.includes(l)) && have.runs.length >= o.runs) {
    deps.log(
      `arm ${state.stamp.slice(0, 7)} (${state.commit.slice(0, 7)}${state.dirty ? "+dirty" : ""}): reusing ${have.runs.length} runs`,
    );
    return { arm: have, dir, captured: false };
  }
  const runs: string[] = [];
  let seen = { engine: "", adapter: "" };
  for (let n = 1; n <= o.runs; n += 1) {
    const out = path.join(dir, `run${n}`);
    // The stamp names the folder, so a run that verifies came from these inputs: a failed attempt resumes.
    if (!verifies(() => verifyRun(out, o.scene, layers, poses)))
      await deps.capture({ scene: o.scene, layers, out });
    seen = verifyRun(out, o.scene, layers, poses);
    runs.push(`run${n}`);
  }
  const arm: IArm = {
    version: 1,
    stamp: state.stamp,
    commit: state.commit,
    dirty: state.dirty,
    scene: o.scene,
    tier: o.tier,
    layers,
    runs,
    engine: seen.engine,
    adapter: seen.adapter,
    capturedAt: deps.now().toISOString(),
  };
  writeFileSync(path.join(dir, "arm.json"), `${JSON.stringify(arm, null, 2)}\n`);
  return { arm, dir, captured: true };
}

/**
 * The compare rows of every run of an arm at one layer, as regions checked against the layer's thresholds.
 * The rows read the committed Unreal statistics, the same reference `--lock` re-measures, so a local Unreal
 * tree that is older than the committed reference changes the judge's images but not the numbers.
 */
function regionsOf(
  deps: IDeps,
  o: IOptions,
  dir: string,
  arm: IArm,
  layer: string,
  limitLayer: string,
): IRegion[] {
  const limits = lightLimits(readThresholds(), limitLayer);
  const runs = arm.runs.map((run) => {
    return withOfflineRoot(path.join(dir, run), (root) => deps.compare(o.scene, layer, root)).map(
      (row): IRegion => {
        if (row.deltaE === null || row.dP50 === null || row.iou === null)
          return fail("MISSING_METRIC", `${row.cell}/${row.region}: the compare gave no value`);
        const { pass, ratio } = evaluate(row, limits);
        return {
          pose: row.cell.slice(o.scene.length + 1),
          region: row.region,
          dP50: row.dP50,
          deltaE: row.deltaE,
          dEv: row.dEv50 === null ? null : Math.abs(row.dEv50),
          iou: row.iou,
          pass,
          ratio,
        };
      },
    );
  });
  return averageRuns(runs);
}

const short = (ref: IArmRef) => `${ref.commit.slice(0, 7)}${ref.dirty ? "+dirty" : ""}`;

interface ITile {
  label: string;
  sub: string;
  file: string;
}

function writeSheets(
  roundDir: string,
  o: IOptions,
  poses: string[],
  arms: { before: { arm: IArm; dir: string }; after: { arm: IArm; dir: string } },
  layer: string,
): string {
  const variant = `${GI_LAYER}-${UNREAL_LEVEL[o.tier]}`;
  const tile = (
    name: "BEFORE" | "AFTER",
    pick: { arm: IArm; dir: string },
    pose: string,
    run: string,
  ): ITile => ({
    label: `WASM ENGINE ${name} · ${GI_LAYER} · ${o.tier} · ${pose}`,
    sub: `${short(pick.arm)} · ${pick.arm.adapter} · ${run}`,
    file: frame(path.join(pick.dir, run), o.scene, layer, pose),
  });
  const sheets = poses.map((pose) => ({
    out: path.join(roundDir, "sheets", `${o.scene}-${o.tier}-${pose}.png`),
    rows: arms.after.arm.runs.map((run, i) => [
      {
        label: `UNREAL 5.8.3 · ${variant} · ${pose}`,
        sub: `GI quality ${UNREAL_LEVEL[o.tier]} · same layer and tier as the engine columns`,
        file: frame(o.unreal, o.scene, variant, pose),
      },
      tile("BEFORE", arms.before, pose, arms.before.arm.runs[i] ?? run),
      tile("AFTER", arms.after, pose, run),
    ]),
  }));
  const spec = path.join(roundDir, "sheets", "spec.json");
  mkdirSync(path.dirname(spec), { recursive: true });
  writeFileSync(spec, `${JSON.stringify({ sheets }, null, 2)}\n`);
  return spec;
}

function missingUnreal(o: IOptions, poses: string[]): string[] {
  const variants = ["ID", "L1", `${GI_LAYER}-${UNREAL_LEVEL[o.tier]}`];
  return variants.flatMap((variant) =>
    poses
      .map((pose) => frame(o.unreal, o.scene, variant, pose))
      .filter((file) => !existsSync(file)),
  );
}

/** Everything a round needs that costs no GPU time: the harness layer, the Unreal frames and the criteria. */
async function preflight(deps: IDeps, o: IOptions, layer: string, poses: string[]) {
  if (!(await deps.captureLayers()).includes(layer))
    fail(
      "NO_TIER_LAYER",
      `the capture harness does not draw layer ${layer} yet (PRD-644 adds the tier layers)`,
    );
  const lacking = missingUnreal(o, poses);
  if (lacking.length > 0)
    fail(
      "MISSING_CELL",
      `the Unreal tree lacks ${lacking.length} frame(s), for example ${lacking[0]}`,
    );
  const criteria = path.join(GI, o.scene, "criteria.md");
  const brief = path.join(GI, "judge-brief.md");
  for (const file of [criteria, brief])
    if (!existsSync(file) || readFileSync(file, "utf8").trim() === "")
      fail(
        "NO_CRITERIA",
        `${file} is missing or empty: the owning PRD writes the criteria before the first round`,
      );
  return { criteria, brief };
}

/** PRD-646: GI is compared only where direct light already matches, so the L1 cells (GI off) come first. */
function directLightOf(deps: IDeps, o: IOptions, after: { arm: IArm; dir: string }) {
  const direct = regionsOf(deps, o, after.dir, after.arm, "L1", "L1");
  const directLight = {
    pass: direct.every((item) => item.pass),
    overridden: false,
    worst: Math.max(...direct.map((item) => item.ratio)),
  };
  if (directLight.pass) return directLight;
  const worst = direct
    .filter((item) => !item.pass)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);
  const lines = worst.map((item) => `${item.pose}/${item.region} ${item.ratio}x`).join(", ");
  if (!o.allowRed)
    fail(
      "DIRECT_LIGHT_RED",
      `the L1 cells (GI off) are outside the thresholds (${lines}): GI is judged only where direct light matches (PRD-646). Pass --allow-red-direct-light to run the round anyway; it is recorded and never counts toward parity`,
    );
  deps.log(`direct light RED, round continues over --allow-red-direct-light: ${lines}`);
  return { ...directLight, overridden: true };
}

/** Where each scene stands: the latest round of every scene and tier on the scoreboard, with its gaps and parity. */
function status(args: string[], deps: IDeps): number {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        status: { type: "boolean" },
        scene: { type: "string" },
        tier: { type: "string" },
        scoreboard: { type: "string" },
      },
    }).values;
  } catch (error) {
    return fail("BAD_INPUT", `${(error as Error).message}\n${USAGE}`);
  }
  const scene = typeof values.scene === "string" ? values.scene.replace(/^gi:/, "") : undefined;
  const tier = typeof values.tier === "string" ? values.tier : undefined;
  if (tier !== undefined) tierLayer(tier);
  const dir = path.resolve(String(values.scoreboard ?? path.join(GI, "parity")));
  const rounds = readRounds(dir).filter(
    (round) =>
      (scene === undefined || round.scene === scene) && (tier === undefined || round.tier === tier),
  );
  if (rounds.length === 0) {
    deps.log(
      `no round on the scoreboard (${dir}) for ${scene ?? "any scene"} at ${tier ?? "any tier"}`,
    );
    return 0;
  }
  const groups = new Map<string, IRound[]>();
  for (const round of rounds) {
    const key = `${round.scene} ${round.tier}`;
    groups.set(key, [...(groups.get(key) ?? []), round]);
  }
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [latest] = [...group].sort((a, b) => b.date.localeCompare(a.date));
    if (latest === undefined) continue;
    const poses = latest.cells.map((cell) => cell.pose);
    deps.log(
      `${group.length} round(s)\n${report(latest, parity(group, latest.scene, latest.tier, poses))}\n`,
    );
  }
  return 0;
}

/**
 * The GI locks of this scene and layer, checked against the runs of the AFTER arm (PRD-654). It logs the
 * result and returns the number of broken bounds. A scene with no lock at this layer logs nothing.
 */
function checkLocks(
  deps: IDeps,
  o: IOptions,
  after: { arm: IArm; dir: string },
  layer: string,
): number {
  if (!existsSync(o.locks)) return 0;
  const locks = readGiLocks(o.locks);
  if (!locks.some((lock) => lock.scene === o.scene && lock.layer === layer)) return 0;
  // A lock cut against another scene or Unreal reference cannot judge this round: say so, and do not fail it.
  const basis = sceneBasis(o.scene);
  const stale = staleLocks(locks, o.scene, layer, basis);
  if (stale.length > 0) {
    deps.log(
      `GI locks STALE: ${stale.length} lock(s) of ${o.scene} at ${layer} were cut against another scene or Unreal reference (round ${stale[0]?.round}), so this round is not checked against them. Approve this round, then pnpm unreal-look:calibrate --lock <round id> --relax`,
    );
    return 0;
  }
  const runs = after.arm.runs.map((run) =>
    withOfflineRoot(path.join(after.dir, run), (root) => deps.compare(o.scene, layer, root)),
  );
  const broken = checkGiLocks(o.scene, layer, runs, locks, basis);
  deps.log(
    broken.length === 0
      ? `GI locks hold: every locked region of ${o.scene} at ${layer} is inside its bound`
      : `GI LOCKS BROKEN (${broken.length}): the change makes a locked region worse\n  ${broken.join("\n  ")}\n  fix the regression, or pass --relax to pnpm unreal-look:calibrate --lock <round> once the owner accepts it`,
  );
  return broken.length;
}

/** The round file and the arm still agree, within what a round file keeps (four digits). */
const near = (a: number, b: number) =>
  Math.abs(a - b) <= 2e-3 * Math.max(Math.abs(a), Math.abs(b)) + 1e-4;

/** The first region (as `pose/region`) whose numbers in the re-measured `runs` differ from the round file. */
function firstMismatch(round: IRound, runs: IMeasured[][]): string | undefined {
  const mean = (rows: (IMeasured | undefined)[], pick: (row: IMeasured) => number | null) =>
    rows.reduce((sum, row) => sum + (row ? (pick(row) ?? Number.NaN) : Number.NaN), 0) /
    rows.length;
  for (const cell of round.cells)
    for (const region of cell.regions) {
      const rows = runs.map((run) =>
        run.find(
          (row) => row.cell === `${round.scene}/${cell.pose}` && row.region === region.region,
        ),
      );
      const agrees =
        near(
          mean(rows, (row) => row.dP50),
          region.dP50,
        ) &&
        near(
          mean(rows, (row) => row.deltaE),
          region.deltaE,
        ) &&
        near(
          mean(rows, (row) => row.iou),
          region.iou,
        );
      if (!agrees) return `${cell.pose}/${region.region}`;
    }
  return undefined;
}

function lockOptions(args: string[]) {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        lock: { type: "string" },
        tighten: { type: "boolean" },
        relax: { type: "boolean" },
        store: { type: "string" },
        scoreboard: { type: "string" },
        locks: { type: "string" },
      },
    }).values;
  } catch (error) {
    return fail("BAD_INPUT", `${(error as Error).message}\n${USAGE}`);
  }
  const id = values.lock;
  if (typeof id !== "string" || id === "")
    return fail("BAD_INPUT", `--lock needs a round id\n${USAGE}`);
  if (values.tighten === true && values.relax === true)
    return fail(
      "BAD_INPUT",
      "--tighten and --relax exclude each other: tighten ratchets improvements, relax accepts a regression",
    );
  return {
    id,
    tighten: values.tighten === true,
    relax: values.relax === true,
    scoreboard: path.resolve(String(values.scoreboard ?? path.join(GI, "parity"))),
    store: path.resolve(
      String(
        values.store ??
          process.env.TN_UNREAL_LOOK_ROUNDS ??
          path.join(os.homedir(), ".cache/threenative/unreal-look-rounds"),
      ),
    ),
    file: path.resolve(String(values.locks ?? GI_LOCK_FILE)),
  };
}

/**
 * `--lock <round>`: cut ratchet locks from an approved round (PRD-654). It re-measures the runs of the
 * round's arm against the committed Unreal statistics, checks that they still show the numbers of the round
 * file, and merges the locks into tools/unreal-reference/gi/parity-locks.json. No GPU and no model.
 */
function lockRound(args: string[], deps: IDeps): number {
  const { id, tighten, relax, scoreboard, store, file } = lockOptions(args);
  const round = readRounds(scoreboard).find((candidate) => candidate.id === id);
  if (round === undefined)
    return fail("NO_ROUND", `${id} is not on the scoreboard (${scoreboard})`);
  if (round.after.dirty)
    return fail(
      "DIRTY_ARM",
      `${id} was captured from a dirty tree: approve a round on a clean commit`,
    );
  const dir = armDir(store, round.after.stamp, round.scene, round.tier);
  const arm = readArm(dir);
  if (arm === undefined || arm.stamp !== round.after.stamp)
    return fail(
      "NO_ARM",
      `the arm of ${id} is not in the store ${store}: the round cannot be measured again`,
    );
  const layer = tierLayer(round.tier);
  const runs = arm.runs.map((run) =>
    withOfflineRoot(path.join(dir, run), (root) => deps.compare(round.scene, layer, root)),
  );
  const mismatch = firstMismatch(round, runs);
  if (mismatch !== undefined)
    return fail(
      "ROUND_MISMATCH",
      `${mismatch}: the arm no longer measures what ${id} recorded; lock a round that the store still reproduces`,
    );
  // A lock exists only where the region is at parity with Unreal in every run.
  const split = splitParity(runs);
  const fresh = lockCells(round.id, round.scene, layer, split.runs, sceneBasis(round.scene));
  writeMerged(
    file,
    fresh,
    { tighten, relax },
    deps.log,
    `${round.scene} ${layer} from ${id}`,
    new Set(
      split.off.map((name) => `${round.scene} ${layer} ${name.slice(round.scene.length + 1)}`),
    ),
  );
  return 0;
}

/** `--status` and `--lock` read the store and the scoreboard and run no capture. */
function subcommand(args: string[], deps: IDeps): number | undefined {
  if (args.includes("--status")) return status(args, deps);
  if (args.includes("--lock")) return lockRound(args, deps);
  return undefined;
}

/** A green judge with a broken lock still fails the round: exit 2, the code of a REGRESSION verdict. */
const exitCode = (judge: number, broken: number) => (judge === 0 && broken > 0 ? 2 : judge);

export async function main(
  args = process.argv.slice(2),
  deps: IDeps = defaultDeps(),
): Promise<number> {
  const done = subcommand(args, deps);
  if (done !== undefined) return done;
  if (args.includes("--help")) {
    deps.log(
      `${USAGE}\n\nOne calibration round on a GI scene: capture, numbers, sheets, a fresh judge, the scoreboard.`,
    );
    return 0;
  }
  const o = parse(args);
  const layer = tierLayer(o.tier);
  const layers = ["ID", "L1", layer];
  const poses = readScene(o.scene).scene.poses.map((pose) => pose.name);
  const { criteria, brief } = await preflight(deps, o, layer, poses);

  const state = await deps.state(o.scene);
  if (o.dryRun) {
    const before = o.before === undefined ? "none" : deps.resolve(o.before);
    deps.log(
      `dry run: ${o.scene} tier ${o.tier} layer ${layer}, ${poses.length} poses (${poses.join(", ")}), ${o.runs} runs per arm\n` +
        `AFTER ${state.commit.slice(0, 7)}${state.dirty ? "+dirty" : ""} stamp ${state.stamp.slice(0, 7)}: ${readArm(armDir(o.store, state.stamp, o.scene, o.tier)) ? "captured" : "to capture"}\n` +
        `BEFORE ${before.slice(0, 7)}\nUnreal frames found, criteria ${criteria}`,
    );
    return 0;
  }

  // The BEFORE arm is looked up first: a missing one fails before any GPU time is spent on AFTER.
  const beforeRef = o.captureOnly ? "" : deps.resolve(o.before as string);
  const sameArm = beforeRef === state.commit && !state.dirty;
  const stored =
    o.captureOnly || sameArm ? undefined : findArm(o.store, o.scene, o.tier, beforeRef);
  const after = await ensureArm(deps, o, state, layers, poses);
  if (o.captureOnly) {
    deps.log(`arm ${state.stamp.slice(0, 7)} ready in ${after.dir}`);
    return 0;
  }

  const directLight = directLightOf(deps, o, after);

  const before = stored ?? after;
  const regions = regionsOf(deps, o, after.dir, after.arm, layer, GI_LAYER);
  // The arm holds the L1 frames (GI off) too: the direct-light locks ride on every round.
  const broken = checkLocks(deps, o, after, layer) + checkLocks(deps, o, after, "L1");

  const date = deps.now().toISOString();
  const id = roundId(date, o.scene, o.tier, state.stamp);
  const roundDir = path.join(o.store, "rounds", id);
  mkdirSync(roundDir, { recursive: true });
  await deps.sheet(writeSheets(roundDir, o, poses, { before, after }, layer));
  const roundCriteria = path.join(roundDir, "criteria.md");
  writeFileSync(
    roundCriteria,
    `${readFileSync(brief, "utf8").trim()}\n\n## Criteria for ${o.scene} at tier ${o.tier}\n\n${readFileSync(criteria, "utf8").trim()}\n\n## Numbers (where to look; decide from the images)\n\n${numbersTable(regions)}\n`,
  );

  const verdictFile = path.join(roundDir, "verdict.json");
  const code = await deps.judge([
    "--criteria",
    roundCriteria,
    "--out",
    verdictFile,
    ...before.arm.runs.flatMap((run) => ["--before", path.join(before.dir, run)]),
    ...after.arm.runs.flatMap((run) => ["--after", path.join(after.dir, run)]),
    "--unreal",
    o.unreal,
    "--tier",
    o.tier,
    "--layer",
    GI_LAYER,
    "--expect",
    o.expect,
  ]);

  const round = buildRound(
    {
      date,
      scene: o.scene,
      tier: o.tier,
      expect: o.expect,
      before: { commit: before.arm.commit, stamp: before.arm.stamp, dirty: before.arm.dirty },
      after: { commit: state.commit, stamp: state.stamp, dirty: state.dirty },
      engine: after.arm.engine,
      adapter: after.arm.adapter,
      directLight,
      poses,
    },
    regions,
    JSON.parse(readFileSync(verdictFile, "utf8")),
  );
  mkdirSync(o.scoreboard, { recursive: true });
  writeFileSync(path.join(o.scoreboard, `${round.id}.json`), `${JSON.stringify(round, null, 2)}\n`);
  deps.log(report(round, parity(readRounds(o.scoreboard), o.scene, o.tier, poses)));
  deps.log(
    `sheets: ${path.join(roundDir, "sheets")}\nscoreboard: ${path.join(o.scoreboard, `${round.id}.json`)}`,
  );
  return exitCode(code, broken);
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `TN_UNREAL_LOOK_CALIBRATE_COMMAND: ${command} ${args.slice(0, 3).join(" ")} exited ${code}`,
            ),
          ),
    );
  });
}

function defaultDeps(): IDeps {
  return {
    captureLayers: async () => Object.keys((await import("./capture-gi-threenative.js")).GI_LAYERS),
    state: async (scene) => {
      // What decides the pixels: the framework, the scaffold, the capture code, the scene and the Wasm pair.
      const paths = [
        "packages",
        "scripts/unreal-look/scaffold",
        "scripts/unreal-look/capture.ts",
        "scripts/unreal-look/capture-gi-threenative.ts",
        "scripts/unreal-look/capture-threenative.ts",
        `tools/unreal-reference/gi/${scene}/scene.json`,
        `tools/unreal-reference/gi/${scene}/scene.glb`,
        "tools/unreal-reference/gi/scenes.json",
        "tools/unreal-reference/layers.json",
        "tools/unreal-reference/poses.json",
      ];
      const engine = path.join(REPO_ROOT, "packages/runtime-native/build/web/tn-native-engine-web");
      const { frameworkStamp } = await import("./capture-threenative.js");
      return {
        commit: git("rev-parse", "HEAD"),
        dirty: git("status", "--porcelain", "--", ...paths) !== "",
        stamp: frameworkStamp(REPO_ROOT, paths, [`${engine}.mjs`, `${engine}.wasm`]),
      };
    },
    resolve: (ref) => git("rev-parse", "--verify", `${ref}^{commit}`),
    capture: ({ scene, layers, out }) => {
      const wrapper = (process.env.TN_UNREAL_LOOK_GPU_WRAPPER ?? "").split(/\s+/).filter(Boolean);
      const argv = [
        ...wrapper,
        "pnpm",
        "unreal-look:capture",
        "--engine",
        "threenative",
        "--scene",
        `gi:${scene}`,
        "--layers",
        layers.join(","),
        "--out",
        out,
        "--reuse",
      ];
      return run(argv[0] as string, argv.slice(1));
    },
    compare: (scene, layer, root) => compareGiToUnreal(scene, [layer], root),
    judge: (args) => judgeMain(args),
    sheet: (spec) => run("python3", ["-I", path.join(GI, "round_sheet.py"), spec]),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
