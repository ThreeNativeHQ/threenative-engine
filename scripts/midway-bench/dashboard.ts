/**
 * Midway tab of `pnpm perf:live`: reads the run directories `flight.sh` writes (`<tag>-<arm>/run.log`
 * and `parity.json`) and reduces them to KPIs. It times nothing itself and writes nothing.
 *
 * Fail closed: a log line whose JSON does not parse is skipped and counted, and a run with no usable
 * samples reports `undefined`, never a zero. A KPI with no data is `pending`, never `pass`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Run directories; `MIDWAY_RUNS` overrides it. */
export const runsDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.MIDWAY_RUNS ?? path.join(os.homedir(), ".cache", "tmp-tn", "midway-runs");

export const ARMS = ["legacy", "native", "desktop"] as const;
export type Arm = (typeof ARMS)[number];
export const POSES = ["takeoff", "cockpit", "reargun"] as const;
/** PRD-610 targets. */
export const TARGETS = { hudP95Ms: 16.7, matrixVisited: 1500, webRatio: 1 } as const;
const LAST = 1000;
const PLAYER_KEYS = [
  "cpuFrameCpuMs",
  "frameMs",
  "renderCpuMs",
  "gameJsCpuMs",
  "presentCpuMs",
  "bridgeCalls",
] as const;

export interface IScan<T> {
  /** JSON objects that parsed. */
  values: T[];
  /** Marker lines whose JSON was cut off or did not parse. */
  skipped: number;
}

/** Index just past the `}` that closes the object opening at `start`, or -1 when the text ends first. */
function objectEnd(text: string, start: number): number {
  const token = /"(?:[^"\\]|\\.)*"|[{}]/g;
  token.lastIndex = start;
  let depth = 0;
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}" && --depth === 0) return token.lastIndex;
  }
  return -1;
}

/** Every `<marker>{...}` JSON object in a log. Playtest logs escape the quotes, so those are undone first. */
export function scanJson<T = Record<string, unknown>>(text: string, marker: string): IScan<T> {
  const flat = text.includes('\\"') ? text.replaceAll('\\"', '"') : text;
  const out: IScan<T> = { values: [], skipped: 0 };
  for (let at = flat.indexOf(marker); at !== -1; at = flat.indexOf(marker, at + marker.length)) {
    const start = at + marker.length;
    if (flat[start] !== "{") {
      out.skipped++;
      continue;
    }
    const end = objectEnd(flat, start);
    try {
      if (end === -1) throw new Error("unterminated");
      out.values.push(JSON.parse(flat.slice(start, end)) as T);
    } catch {
      out.skipped++;
    }
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest rank on `n - 1`, the rule the reference `frames.py` uses. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

export interface IDesktopFrames {
  n: number;
  medians: Partial<Record<(typeof PLAYER_KEYS)[number], number>>;
  frameP95?: number;
}

/** Medians over the last `last` `TN_PLAYER_FRAME` samples of a desktop run. */
export function playerFrames(text: string, last = LAST) {
  const { values, skipped } = scanJson<Record<string, unknown>>(text, "TN_PLAYER_FRAME:");
  const tail = values.slice(-last);
  if (!tail.length) return { skipped };
  const medians: IDesktopFrames["medians"] = {};
  for (const key of PLAYER_KEYS) {
    const m = median(tail.map((s) => s[key]).filter(finite));
    if (m !== undefined) medians[key] = m;
  }
  const frameP95 = percentile(tail.map((s) => s.frameMs).filter(finite), 0.95);
  return {
    skipped,
    frames: { n: tail.length, medians, ...(frameP95 === undefined ? {} : { frameP95 }) },
  };
}

export interface IBudget {
  windows: number;
  frameP50: number;
  frameP95?: number;
  fps?: number;
  hitches?: number;
}

interface IWindow {
  fps?: unknown;
  frame?: { p50?: unknown; p95?: unknown };
  hitches?: unknown;
}

/** `TN_FRAME_BUDGET` windows (web arms, and the desktop player too): median of the per-window frame times. */
export function frameBudget(text: string) {
  const { values, skipped } = scanJson<IWindow>(text, "TN_FRAME_BUDGET:");
  const ok = values.filter((w) => finite(w.frame?.p50));
  const pick = (get: (w: IWindow) => unknown) => median(ok.map(get).filter(finite));
  const frameP50 = pick((w) => w.frame?.p50);
  if (frameP50 === undefined) return { skipped: skipped + values.length - ok.length };
  const opt = (key: string, value: number | undefined) =>
    value === undefined ? {} : { [key]: value };
  const budget: IBudget = {
    windows: ok.length,
    frameP50,
    ...opt(
      "frameP95",
      pick((w) => w.frame?.p95),
    ),
    ...opt(
      "fps",
      pick((w) => w.fps),
    ),
    ...opt(
      "hitches",
      pick((w) => w.hitches),
    ),
  };
  return { skipped: skipped + values.length - ok.length, budget };
}

/** HUD snapshot round trip (`lastRoundTripMs`) p50 and p95 over every `TN_UI_SNAPSHOT`. */
export function uiRoundTrip(text: string) {
  const { values, skipped } = scanJson<Record<string, unknown>>(text, "TN_UI_SNAPSHOT:");
  const ms = values.map((v) => v.lastRoundTripMs).filter(finite);
  const dropped = skipped + values.length - ms.length;
  if (!ms.length) return { skipped: dropped };
  return {
    skipped: dropped,
    ui: { n: ms.length, p50: median(ms) as number, p95: percentile(ms, 0.95) as number },
  };
}

/** Matrix-walk `visited` counts from the projection lines: the last one in the run is the flight value. */
export function matrixWalk(text: string) {
  const flat = text.replaceAll('\\"', '"');
  const seen = [...flat.matchAll(/"matrixWorld":\{"mode":"[^"]*","visited":(\d+)\}/g)].map((m) =>
    Number(m[1]),
  );
  if (!seen.length) return undefined;
  return { n: seen.length, last: seen.at(-1) as number, max: Math.max(...seen) };
}

export interface IParity {
  pass: boolean;
  frames: Record<string, { meanSsim?: number; worstTile?: number; pass: boolean }>;
}

/** `parity.json` as `parity.ts` writes it (a verdict line follows the JSON). Malformed means `undefined`. */
export function parityOf(text: string): IParity | undefined {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last < first) return undefined;
  try {
    const raw = JSON.parse(text.slice(first, last + 1)) as {
      pass?: unknown;
      frames?: Record<
        string,
        { nativeMeanSsim?: unknown; nativeWorstTile?: unknown; pass?: unknown }
      >;
    };
    if (typeof raw.pass !== "boolean" || typeof raw.frames !== "object" || raw.frames === null)
      return undefined;
    const frames: IParity["frames"] = {};
    for (const [name, f] of Object.entries(raw.frames)) {
      const mean = Array.isArray(f.nativeMeanSsim)
        ? median(f.nativeMeanSsim.filter(finite))
        : undefined;
      frames[name] = {
        pass: f.pass === true,
        ...(mean === undefined ? {} : { meanSsim: mean }),
        ...(finite(f.nativeWorstTile) ? { worstTile: f.nativeWorstTile } : {}),
      };
    }
    return { pass: raw.pass, frames };
  } catch {
    return undefined;
  }
}

export interface IMidwayRun {
  dir: string;
  tag: string;
  /** The tag without its trailing run number: `walk-a1` and `walk-a2` are group `walk-a`. */
  group: string;
  arm: Arm;
  mtimeMs: number;
  /** `no samples` when the log held none; `ok` otherwise. */
  status: "ok" | "no samples";
  desktop?: IDesktopFrames;
  budget?: IBudget;
  ui?: { n: number; p50: number; p95: number };
  matrix?: { n: number; last: number; max: number };
  parity?: IParity;
  /** `parity.json` exists but does not parse. */
  parityMalformed?: true;
  /** Marker lines dropped because their JSON was malformed. */
  skipped: number;
}

export function runOf(
  dir: string,
  tag: string,
  arm: Arm,
  mtimeMs: number,
  log: string,
  parityText?: string,
): IMidwayRun {
  const player = arm === "desktop" ? playerFrames(log) : { skipped: 0 };
  const budget = frameBudget(log);
  const ui = uiRoundTrip(log);
  const matrix = matrixWalk(log);
  const parity = parityText === undefined ? undefined : parityOf(parityText);
  const desktop = "frames" in player ? player.frames : undefined;
  const run: IMidwayRun = {
    dir,
    tag,
    group: tag.replace(/\d+$/, "") || tag,
    arm,
    mtimeMs,
    status: desktop || budget.budget ? "ok" : "no samples",
    skipped: player.skipped + budget.skipped + ui.skipped,
    ...(desktop ? { desktop } : {}),
    ...(budget.budget ? { budget: budget.budget } : {}),
    ...("ui" in ui ? { ui: ui.ui } : {}),
    ...(matrix ? { matrix } : {}),
    ...(parity ? { parity } : {}),
    ...(parityText !== undefined && !parity ? { parityMalformed: true as const } : {}),
  };
  return run;
}

const cache = new Map<string, { mtime: number; run: IMidwayRun }>();

/** Every `<tag>-<arm>` directory under the runs dir, oldest first. Other entries are ignored. */
export async function loadMidwayRuns(root = runsDir()): Promise<IMidwayRun[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const runs: IMidwayRun[] = [];
  for (const entry of entries) {
    const m = /^(.+)-(legacy|native|desktop)$/.exec(entry.name);
    if (!entry.isDirectory() || !m) continue;
    const dir = path.join(root, entry.name);
    const logStat = await stat(path.join(dir, "run.log")).catch(() => undefined);
    if (!logStat) continue;
    const parityStat = await stat(path.join(dir, "parity.json")).catch(() => undefined);
    const mtime = Math.max(logStat.mtimeMs, parityStat?.mtimeMs ?? 0);
    let hit = cache.get(dir);
    if (hit?.mtime !== mtime) {
      const log = await readFile(path.join(dir, "run.log"), "utf8");
      const parityText = parityStat
        ? await readFile(path.join(dir, "parity.json"), "utf8")
        : undefined;
      hit = {
        mtime,
        run: runOf(entry.name, m[1] as string, m[2] as Arm, logStat.mtimeMs, log, parityText),
      };
      cache.set(dir, hit);
    }
    runs.push(hit.run);
  }
  return runs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.dir.localeCompare(b.dir));
}

export type Verdict = "pass" | "fail" | "pending";
export interface IKpi {
  id: string;
  title: string;
  target: string;
  verdict: Verdict;
  value?: string;
  detail: string;
}

/** Main-thread ms per frame that both arms report: legacy and web Wasm `frame.p50`, desktop `cpuFrameCpuMs`. */
export const mainThreadMs = (run: IMidwayRun) =>
  run.arm === "desktop" ? run.desktop?.medians.cpuFrameCpuMs : run.budget?.frameP50;

const latest = (runs: readonly IMidwayRun[], arm: Arm, has: (r: IMidwayRun) => boolean) =>
  runs.filter((r) => r.arm === arm && has(r)).at(-1);

/** The legacy reference: median over every legacy run that has a frame time. */
export const legacyMs = (runs: readonly IMidwayRun[]) =>
  median(
    runs
      .filter((r) => r.arm === "legacy")
      .map(mainThreadMs)
      .filter(finite),
  );

const parityVerdict = (run: IMidwayRun | undefined) =>
  !run?.parity
    ? "no parity.json"
    : run.parity.pass && POSES.every((p) => run.parity?.frames[p]?.pass)
      ? undefined
      : "parity FAIL";

/** PRD-610 acceptance criteria as pass, fail or pending cards. */
export function kpisOf(runs: readonly IMidwayRun[]): IKpi[] {
  const desktop = latest(runs, "desktop", (r) => r.desktop !== undefined);
  const web = latest(runs, "native", (r) => r.budget !== undefined);
  const legacy = legacyMs(runs);
  const ratioKpi = (
    id: string,
    title: string,
    target: string,
    run: IMidwayRun | undefined,
    floor: number,
    label: string,
  ): IKpi => {
    const ms = run ? mainThreadMs(run) : undefined;
    if (!run || ms === undefined || legacy === undefined)
      return {
        id,
        title,
        target,
        verdict: "pending",
        detail: `no samples: need a ${label} run and a legacy run`,
      };
    const ratio = legacy / ms;
    const bad = parityVerdict(run);
    const faster = floor === 1 ? ratio > 1 : ratio >= floor;
    return {
      id,
      title,
      target,
      verdict: bad === undefined && faster ? "pass" : "fail",
      value: `${ratio.toFixed(2)}x`,
      detail: `${run.dir}: ${ms.toFixed(2)} ms vs legacy ${legacy.toFixed(2)} ms${bad ? `, ${bad}` : ", parity PASS"}. Run level, poses are not separated in the logs.`,
    };
  };
  const hud = desktop?.ui;
  const matrix = desktop?.matrix;
  return [
    ratioKpi(
      "AC-6",
      "Desktop beats three.js",
      "ratio above 1.0, parity PASS",
      desktop,
      1,
      "desktop",
    ),
    ratioKpi(
      "AC-7",
      "Web Wasm vs three.js",
      "ratio at least 1.0, parity PASS",
      web,
      TARGETS.webRatio,
      "native",
    ),
    hud
      ? {
          id: "AC-5",
          title: "HUD round trip",
          target: `p95 below ${TARGETS.hudP95Ms} ms`,
          verdict: hud.p95 < TARGETS.hudP95Ms ? "pass" : "fail",
          value: `${hud.p95.toFixed(1)} ms`,
          detail: `${desktop?.dir}: p50 ${hud.p50.toFixed(1)} ms, p95 ${hud.p95.toFixed(1)} ms over ${hud.n} snapshots`,
        }
      : {
          id: "AC-5",
          title: "HUD round trip",
          target: `p95 below ${TARGETS.hudP95Ms} ms`,
          verdict: "pending",
          detail: "no samples: no desktop run with TN_UI_SNAPSHOT",
        },
    matrix
      ? {
          id: "AC-3",
          title: "Matrix walk",
          target: `visited at most ${TARGETS.matrixVisited}`,
          verdict: matrix.last <= TARGETS.matrixVisited ? "pass" : "fail",
          value: matrix.last.toLocaleString("en-US"),
          detail: `${desktop?.dir}: last ${matrix.last}, max ${matrix.max} over ${matrix.n} projection lines`,
        }
      : {
          id: "AC-3",
          title: "Matrix walk",
          target: `visited at most ${TARGETS.matrixVisited}`,
          verdict: "pending",
          detail: "no samples: no desktop projection line",
        },
  ];
}

export interface IGroup {
  group: string;
  arm: Arm;
  runs: number;
  cpuFrameMs?: number;
  frameP95?: number;
  hudP95?: number;
  matrixLast?: number;
  parityPass: number;
}

/** A/B grouping by tag prefix and arm: `walk-a1..a3` against `walk-b1..b3`. */
export function groupsOf(runs: readonly IMidwayRun[]): IGroup[] {
  const by = new Map<string, IMidwayRun[]>();
  for (const r of runs)
    by.set(`${r.group}\0${r.arm}`, [...(by.get(`${r.group}\0${r.arm}`) ?? []), r]);
  const med = (list: readonly IMidwayRun[], get: (r: IMidwayRun) => number | undefined) =>
    median(list.map(get).filter(finite));
  return [...by.values()].map((list) => {
    const first = list[0] as IMidwayRun;
    const opt = <K extends string>(key: K, value: number | undefined) =>
      value === undefined ? {} : { [key]: value };
    return {
      group: first.group,
      arm: first.arm,
      runs: list.length,
      parityPass: list.filter((r) => r.parity?.pass).length,
      ...opt("cpuFrameMs", med(list, mainThreadMs)),
      ...opt(
        "frameP95",
        med(list, (r) => r.desktop?.frameP95 ?? r.budget?.frameP95),
      ),
      ...opt(
        "hudP95",
        med(list, (r) => r.ui?.p95),
      ),
      ...opt(
        "matrixLast",
        med(list, (r) => r.matrix?.last),
      ),
    };
  });
}

export function midwayOf(runs: readonly IMidwayRun[]) {
  return {
    kpis: kpisOf(runs),
    groups: groupsOf(runs),
    legacyMs: legacyMs(runs),
    runs,
    skipped: runs.reduce((n, r) => n + r.skipped, 0),
    dir: runsDir(),
  };
}
