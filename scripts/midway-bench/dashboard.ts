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

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

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

/** `cull.json` as `{"sharePct": n}`; anything else is no sample. */
export function cullOf(text: string | undefined): number | undefined {
  try {
    const v = (JSON.parse(text ?? "") as { sharePct?: unknown }).sharePct;
    return finite(v) && v >= 0 ? v : undefined;
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
  /** The build that ran it: the `pkg-<name>` directory of the player path in the log (desktop runs). */
  pkg?: string;
  /** `no samples` when the log held none; `ok` otherwise. */
  status: "ok" | "no samples";
  desktop?: IDesktopFrames;
  budget?: IBudget;
  ui?: { n: number; p50: number; p95: number };
  matrix?: { n: number; last: number; max: number };
  parity?: IParity;
  /** Share of the main thread `ProjectedCull::apply` takes, in percent, from an optional `cull.json` (`{"sharePct": n}`). */
  cullPct?: number;
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
  cullText?: string,
): IMidwayRun {
  const player = arm === "desktop" ? playerFrames(log) : { skipped: 0 };
  const budget = frameBudget(log);
  const ui = uiRoundTrip(log);
  const matrix = matrixWalk(log);
  const parity = parityText === undefined ? undefined : parityOf(parityText);
  const cullPct = cullOf(cullText);
  const pkg = /\/((?:pkg|player)-[\w.-]+)\/tn-native-engine-player-v8/.exec(log)?.[1];
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
    ...(cullPct === undefined ? {} : { cullPct }),
    ...(pkg ? { pkg } : {}),
    ...(parityText !== undefined && !parity ? { parityMalformed: true as const } : {}),
  };
  return run;
}

const cache = new Map<string, { mtime: number; run: IMidwayRun }>();

async function readRun(root: string, name: string, tag: string, arm: Arm) {
  const dir = path.join(root, name);
  const logStat = await stat(path.join(dir, "run.log")).catch(() => undefined);
  if (!logStat) return undefined;
  const parityStat = await stat(path.join(dir, "parity.json")).catch(() => undefined);
  const cullStat = await stat(path.join(dir, "cull.json")).catch(() => undefined);
  const mtime = Math.max(logStat.mtimeMs, parityStat?.mtimeMs ?? 0, cullStat?.mtimeMs ?? 0);
  const hit = cache.get(dir);
  if (hit?.mtime === mtime) return hit.run;
  const optional = (file: string, has: unknown) =>
    has ? readFile(path.join(dir, file), "utf8") : undefined;
  const run = runOf(
    name,
    tag,
    arm,
    logStat.mtimeMs,
    await readFile(path.join(dir, "run.log"), "utf8"),
    await optional("parity.json", parityStat),
    await optional("cull.json", cullStat),
  );
  cache.set(dir, { mtime, run });
  return run;
}

/** Every `<tag>-<arm>` directory under the runs dir, oldest first. Other entries are ignored. */
export async function loadMidwayRuns(root = runsDir()): Promise<IMidwayRun[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const runs: IMidwayRun[] = [];
  for (const entry of entries) {
    const m = /^(.+)-(legacy|native|desktop)$/.exec(entry.name);
    const run =
      entry.isDirectory() && m
        ? await readRun(root, entry.name, m[1] as string, m[2] as Arm)
        : undefined;
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.dir.localeCompare(b.dir));
}
