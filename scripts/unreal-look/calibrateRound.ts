/**
 * The numbers and the records of a PRD-647 calibration round, with no file capture, GPU or model in
 * it: the thresholds check, the averaging of the two runs, the scoreboard entry, the gap list and the
 * parity rule. `calibrate.ts` runs the round and calls these.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type IThresholdFile, type IThresholds, layerThresholds } from "./compare.js";
import {
  CLOSENESS,
  type Closeness,
  type Expect,
  type Tier,
  VERDICTS,
  type Verdict,
} from "./judgeVerdict.js";

export function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_CALIBRATE_${code}: ${message}`);
}

/** The layer every GI tier is judged at; the tier decides the Unreal level it is judged against. */
export const GI_LAYER = "L7";
/** Rounds needed on one stamp before a scene is at parity (PRD-647 parity rule). */
export const JUDGE_ROUNDS = 2;

const TIER_LAYER: Readonly<Record<Tier, string>> = {
  high: `${GI_LAYER}-high`,
  medium: `${GI_LAYER}-medium`,
  low: `${GI_LAYER}-low`,
};

/** The capture layer of a GI tier (PRD-644): it names the tier instead of leaving it to the engine default. */
export function tierLayer(tier: string): string {
  if (!Object.hasOwn(TIER_LAYER, tier)) fail("BAD_INPUT", `--tier ${tier}: high, medium or low`);
  return TIER_LAYER[tier as Tier];
}

/** What the capture read back from `navigator.gpu`; a software adapter or no name fails the round. */
export function adapterName(adapter: unknown): string {
  const info = (adapter ?? {}) as Record<string, unknown>;
  const name = ["vendor", "architecture", "device", "description"]
    .map((key) => String(info[key] ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (name === "") fail("UNNAMED_ADAPTER", "the capture did not name the WebGPU adapter");
  if (/swiftshader|llvmpipe|software/i.test(name))
    fail("SOFTWARE_ADAPTER", `${name} is a software adapter: capture on the GPU`);
  return name;
}

/**
 * The limits of one layer from thresholds.json, read by the function that every compare uses
 * (`layerThresholds`). A layer that sets no limit on the light (deltaE and dP50) fails closed: the flat IoU
 * limit alone would let any frame through, as in the GI compare.
 */
export function lightLimits(file: IThresholdFile | null, layer: string): IThresholds {
  const limits = layerThresholds(file, layer);
  if (limits?.deltaE === undefined || limits.dP50 === undefined)
    fail("NO_THRESHOLDS", `thresholds.json sets no deltaE and dP50 limit for layer ${layer}`);
  return limits;
}

/** The part of a compare row the round reads. */
export interface IMeasured {
  cell: string;
  region: string;
  deltaE: number | null;
  dP50: number | null;
  dEv50: number | null;
  iou: number | null;
  /** The reference statistics of the region: its median sets the step of dP50 and deltaE (PRD-653). */
  unreal?: { p50: number } | null;
}

/**
 * Pass when every metric that has a limit is inside it. The ratio is the worst metric over its limit
 * (the limit over the value for the IoU), so 1 sits on the threshold and 3.4 is 3.4 times past it.
 */
export function evaluate(row: IMeasured, limits: IThresholds): { pass: boolean; ratio: number } {
  const checks: [number | null, number | undefined, boolean][] = [
    [row.deltaE, limits.deltaE, false],
    [row.dP50, limits.dP50, false],
    [row.dEv50 === null ? null : Math.abs(row.dEv50), limits.dEv, false],
    [row.iou, limits.iou, true],
  ];
  const used = checks.filter(
    (check): check is [number, number, boolean] =>
      typeof check[0] === "number" && typeof check[1] === "number",
  );
  if (used.length === 0) fail("NO_METRIC", `${row.cell}/${row.region}: no metric has a limit`);
  const ratio = Math.max(
    ...used.map(([value, limit, minimum]) =>
      minimum ? limit / Math.max(value, 1e-9) : value / limit,
    ),
  );
  return { pass: ratio <= 1, ratio };
}

/** One region of one pose, from one run or averaged over the runs of an arm. */
export interface IRegion {
  pose: string;
  region: string;
  dP50: number;
  deltaE: number;
  /** Null when the Unreal frame has no linear (EXR) copy to read an EV from. */
  dEv: number | null;
  iou: number;
  pass: boolean;
  ratio: number;
  /** Range of dP50 between the runs: how much two captures of one arm differ. */
  spread?: number;
}

const round4 = (value: number) => Number(value.toPrecision(4));

/** The mean over the runs of an arm. The ratio is the worst run and the arm passes only if every run does. */
export function averageRuns(runs: readonly (readonly IRegion[])[]): IRegion[] {
  if (runs.length < 2)
    fail("TOO_FEW_RUNS", `${runs.length} run(s): the visual judge rule asks for two per arm`);
  const first = runs[0] as readonly IRegion[];
  const key = (item: IRegion) => `${item.pose}/${item.region}`;
  for (const run of runs)
    if (
      run.length !== first.length ||
      run.some((item, i) => key(item) !== key(first[i] as IRegion))
    )
      fail("RUN_MISMATCH", "the runs of one arm do not measure the same regions of the same poses");
  return first.map((item, i) => {
    const at = runs.map((run) => run[i] as IRegion);
    const mean = (pick: (value: IRegion) => number) =>
      at.reduce((sum, value) => sum + pick(value), 0) / at.length;
    const dP50 = at.map((value) => value.dP50);
    const evs = at.flatMap((value) => (value.dEv === null ? [] : [value.dEv]));
    return {
      pose: item.pose,
      region: item.region,
      dP50: round4(mean((value) => value.dP50)),
      deltaE: round4(mean((value) => value.deltaE)),
      dEv:
        evs.length === 0 ? null : round4(evs.reduce((sum, value) => sum + value, 0) / evs.length),
      iou: round4(mean((value) => value.iou)),
      pass: at.every((value) => value.pass),
      ratio: round4(Math.max(...at.map((value) => value.ratio))),
      spread: round4(Math.max(...dP50) - Math.min(...dP50)),
    };
  });
}

export interface IArmRef {
  commit: string;
  stamp: string;
  dirty: boolean;
}
export interface ICell {
  pose: string;
  verdict: Verdict;
  vsUnreal: Closeness;
  reasons: string;
  differences: string;
  /** The worst region over its threshold: the numeric delta that orders the gap list. */
  worst: number;
  regions: Omit<IRegion, "pose">[];
}
export interface IRound {
  version: 1;
  id: string;
  date: string;
  scene: string;
  tier: Tier;
  expect: Expect;
  before: IArmRef;
  after: IArmRef;
  engine: string;
  adapter: string;
  /** PRD-646: the L1 cells (GI off) match Unreal. A round run over a red check never counts toward parity. */
  directLight: { pass: boolean; overridden: boolean; worst: number };
  cells: ICell[];
  overall: { verdict: Verdict; vsUnreal: Closeness; reasons: string };
  judge: {
    model: string;
    sessionId: string;
    costUsd: number;
    durationMs: number;
    criteriaSha256: string;
  };
}
export interface IRoundMeta {
  date: string;
  scene: string;
  tier: Tier;
  expect: Expect;
  before: IArmRef;
  after: IArmRef;
  engine: string;
  adapter: string;
  directLight: IRound["directLight"];
  poses: readonly string[];
}
/** The verdict file `unreal-look:judge` writes, as far as the round reads it. */
export interface IVerdictFile {
  status?: string;
  model?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  criteria?: { sha256?: string };
  frames?: {
    id: string;
    verdict: string;
    vsUnreal: string;
    reasons?: string;
    differences?: string;
  }[];
  overall?: { verdict: string; vsUnreal: string; reasons?: string };
}

export function roundId(date: string, scene: string, tier: string, stamp: string): string {
  const time = date.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${time}-${scene}-${tier}-${stamp.slice(0, 7)}`;
}

function scaled<T extends string>(value: string, scale: readonly T[], what: string): T {
  if (!scale.includes(value as T))
    fail("BAD_VERDICT", `${what} is ${JSON.stringify(value)}: ${scale.join(", ")}`);
  return value as T;
}

/** One scoreboard entry: the numbers of the AFTER arm and both judge answers, per pose. */
export function buildRound(
  meta: IRoundMeta,
  regions: readonly IRegion[],
  verdict: IVerdictFile,
): IRound {
  if (verdict.status !== "COMPLETE")
    fail("BAD_VERDICT", `the verdict file is ${verdict.status ?? "unreadable"}, not COMPLETE`);
  const frames = verdict.frames ?? [];
  const cells = meta.poses.map((pose): ICell => {
    const frame = frames.find((f) => f.id === `${meta.scene}/${GI_LAYER}/${pose}`);
    if (frame === undefined) fail("MISSING_CELL", `the judge gave no answer for ${pose}`);
    const own = regions.filter((item) => item.pose === pose);
    if (own.length === 0) fail("MISSING_CELL", `no numbers for ${pose}`);
    return {
      pose,
      verdict: scaled(frame.verdict, VERDICTS, `${pose} verdict`),
      vsUnreal: scaled(frame.vsUnreal, CLOSENESS, `${pose} vsUnreal`),
      reasons: frame.reasons ?? "",
      differences: frame.differences ?? "",
      worst: Math.max(...own.map((item) => item.ratio)),
      regions: own.map(({ pose: _pose, ...rest }) => rest),
    };
  });
  const overall = verdict.overall ?? fail("BAD_VERDICT", "the verdict has no overall answer");
  return {
    version: 1,
    id: roundId(meta.date, meta.scene, meta.tier, meta.after.stamp),
    date: meta.date,
    scene: meta.scene,
    tier: meta.tier,
    expect: meta.expect,
    before: meta.before,
    after: meta.after,
    engine: meta.engine,
    adapter: meta.adapter,
    directLight: meta.directLight,
    cells,
    overall: {
      verdict: scaled(overall.verdict, VERDICTS, "overall verdict"),
      vsUnreal: scaled(overall.vsUnreal, CLOSENESS, "overall vsUnreal"),
      reasons: overall.reasons ?? "",
    },
    judge: {
      model: verdict.model ?? "",
      sessionId: verdict.sessionId ?? "",
      costUsd: verdict.costUsd ?? 0,
      durationMs: verdict.durationMs ?? 0,
      criteriaSha256: verdict.criteria?.sha256 ?? "",
    },
  };
}

export interface IGap {
  pose: string;
  vsUnreal: Closeness;
  worst: number;
  region: string;
  differences: string;
}

/** The cells the judge does not call MATCH, the furthest from the thresholds first. */
export function gapList(round: IRound): IGap[] {
  return round.cells
    .filter((cell) => cell.vsUnreal !== "MATCH")
    .sort((a, b) => b.worst - a.worst)
    .map((cell) => ({
      pose: cell.pose,
      vsUnreal: cell.vsUnreal,
      worst: cell.worst,
      region: [...cell.regions].sort((a, b) => b.ratio - a.ratio)[0]?.region ?? "",
      differences: cell.differences,
    }));
}

export interface IParity {
  atParity: boolean;
  reasons: string[];
}

/**
 * A scene is at parity at a tier when two fresh judge rounds on the same stamp (the same pixels)
 * return MATCH on every cell, the direct light check was green, and every region of the latest round
 * is inside the thresholds. One round, or one CLOSE cell, keeps it open.
 */
export function parity(
  rounds: readonly IRound[],
  scene: string,
  tier: Tier,
  poses: readonly string[],
): IParity {
  const own = rounds
    .filter((round) => round.scene === scene && round.tier === tier)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const latest = own.at(-1);
  if (latest === undefined) return { atParity: false, reasons: ["no round yet"] };
  const onStamp = own.filter((round) => round.after.stamp === latest.after.stamp);
  const lastTwo = onStamp.slice(-JUDGE_ROUNDS);
  const matches = (round: IRound) =>
    !round.directLight.overridden &&
    poses.every((pose) => round.cells.find((cell) => cell.pose === pose)?.vsUnreal === "MATCH");
  const reasons: string[] = [];
  const matched = lastTwo.filter(matches).length;
  if (lastTwo.length < JUDGE_ROUNDS || matched < JUDGE_ROUNDS)
    reasons.push(
      `${matched} of ${JUDGE_ROUNDS} judge rounds on this stamp returned MATCH on every cell` +
        `${lastTwo.length < JUDGE_ROUNDS ? ` (${lastTwo.length} round so far)` : ""}`,
    );
  if (latest.directLight.overridden)
    reasons.push("the latest round ran over a red direct-light check (--allow-red-direct-light)");
  const outside = latest.cells.flatMap((cell) =>
    cell.regions.filter((r) => !r.pass).map((r) => `${cell.pose}/${r.region}`),
  );
  if (outside.length > 0)
    reasons.push(`regions outside the thresholds: ${outside.slice(0, 6).join(", ")}`);
  return { atParity: reasons.length === 0, reasons };
}

/** Every round file of a scoreboard folder, oldest first. A malformed file fails the read. */
export function readRounds(dir: string): IRound[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .map((name) => {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      } catch (error) {
        fail("BAD_ROUND", `${name}: ${(error as Error).message}`);
      }
      const round = value as Partial<IRound>;
      if (round?.version !== 1 || !round.id || !Array.isArray(round.cells) || !round.after)
        fail("BAD_ROUND", `${name}: not a calibration round (version 1 with id, after and cells)`);
      return round as IRound;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

const times = (ratio: number) => `${Number(ratio.toPrecision(2))}x`;

/** The text `calibrate` prints at the end of a round. */
export function report(round: IRound, status: IParity): string {
  const lines = [
    `ROUND ${round.id}  scene ${round.scene} · tier ${round.tier} · engine ${round.engine} · ${round.adapter}`,
    `BEFORE ${round.before.commit}${round.before.dirty ? "+dirty" : ""} (${round.before.stamp.slice(0, 7)})  AFTER ${round.after.commit}${round.after.dirty ? "+dirty" : ""} (${round.after.stamp.slice(0, 7)})${round.before.stamp === round.after.stamp ? "  same arm" : ""}`,
    round.directLight.pass
      ? `direct light GREEN (L1 worst region ${times(round.directLight.worst)} its limit)`
      : `direct light RED${round.directLight.overridden ? " (overridden with --allow-red-direct-light)" : ""}, worst region ${times(round.directLight.worst)} its limit`,
  ];
  for (const cell of round.cells) {
    const worst = [...cell.regions].sort((a, b) => b.ratio - a.ratio)[0];
    lines.push(
      `  ${cell.pose.padEnd(16)} ${cell.verdict.padEnd(12)} vs Unreal ${cell.vsUnreal.padEnd(6)} worst ${worst?.region ?? "-"} ${times(cell.worst)}`,
    );
  }
  lines.push(
    `OVERALL ${round.overall.verdict} · vs Unreal ${round.overall.vsUnreal} · ${round.overall.reasons}`,
  );
  const gaps = gapList(round);
  lines.push(
    gaps.length === 0
      ? "GAP LIST: none"
      : `GAP LIST (CLOSE or FAR, furthest from the thresholds first):\n${gaps
          .map(
            (gap) =>
              `  ${gap.pose} ${gap.vsUnreal}  ${gap.region} ${times(gap.worst)} its limit${gap.differences ? `  ${gap.differences}` : ""}`,
          )
          .join("\n")}`,
  );
  lines.push(
    status.atParity
      ? `PARITY ${round.scene} ${round.tier}: AT PARITY`
      : `PARITY ${round.scene} ${round.tier}: OPEN - ${status.reasons.join("; ")}`,
  );
  return lines.join("\n");
}

/** The regions outside the thresholds, as a table for the judge: where the numbers disagree, not a verdict. */
export function numbersTable(regions: readonly IRegion[]): string {
  const outside = regions.filter((item) => !item.pass).sort((a, b) => b.ratio - a.ratio);
  const head = `${regions.length - outside.length} of ${regions.length} regions are inside the PRD-631 thresholds.`;
  if (outside.length === 0) return head;
  return [
    `${head} The others, furthest first:`,
    "",
    "| pose | region | dP50 | dE2000 | IoU | times the limit |",
    "|---|---|---:|---:|---:|---:|",
    ...outside
      .slice(0, 12)
      .map(
        (item) =>
          `| ${item.pose} | ${item.region} | ${item.dP50} | ${item.deltaE} | ${item.iou} | ${times(item.ratio)} |`,
      ),
  ].join("\n");
}
