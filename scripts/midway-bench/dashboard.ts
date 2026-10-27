/**
 * Midway tab of `pnpm dashboard`: reads the run directories `flight.sh` writes (`<tag>-<arm>/run.log`
 * and `parity.json`) and reduces them to KPIs. It times nothing itself and writes nothing.
 *
 * Fail closed: a log line whose JSON does not parse is skipped and counted, and a run with no usable
 * samples reports `undefined`, never a zero. A KPI with no data is `pending`, never `pass`.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Run directories; `MIDWAY_RUNS` overrides it. */
export const runsDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.MIDWAY_RUNS ?? path.join(os.homedir(), ".cache", "tmp-tn", "midway-runs");

export const ARMS = ["legacy", "native", "desktop"] as const;
export type Arm = (typeof ARMS)[number];
export const PLAYER_FRAME_WINDOW = 1000;
const PLAYER_KEYS = [
  "cpuFrameCpuMs",
  "frameMs",
  "renderCpuMs",
  "gameJsCpuMs",
  "presentCpuMs",
  "bridgeCalls",
  "cpuFrameKInstructions",
  "cpuFrameKCycles",
] as const;
const WORLD_WORK_PARTS = [
  "worldUpdateVisits",
  "joinDependencyVisits",
  "gpuBoundaryVisits",
  "gpuProjectionBoundaryVisits",
  "gpuPlanValidationVisits",
  "gpuPlanMaintenanceVisits",
] as const;
const WORLD_WORK_V3_PARTS = ["worldDirtyPropagationVisits", "worldSubtreeSkipVisits"] as const;

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
  /** Complete active frames used in the tail, capped at PLAYER_FRAME_WINDOW. */
  n: number;
  /** Complete active frames available in the whole log, before taking the tail. */
  eligible: number;
  /** Parsed player frames excluded for no updates or incomplete measurements. */
  excluded: number;
  medians: Partial<Record<(typeof PLAYER_KEYS)[number], number>>;
  frameP95?: number;
  /** Versioned whole-frame work; scopes differ across versions and from legacy projection visits. */
  worldWork?: { version: 2 | 3; n: number; median: number; max: number };
  /** A tail claims world counters but is mixed, incomplete or invalid. CPU samples remain usable. */
  worldWorkInvalid?: true;
}

/** CPU and instructions share the last `last` complete, active player frames. */
export function playerFrames(
  text: string,
  last = PLAYER_FRAME_WINDOW,
): { skipped: number; frames?: IDesktopFrames } {
  const { values, skipped } = scanJson<Record<string, unknown>>(text, "TN_PLAYER_FRAME:");
  const eligible = values.filter(
    (s) =>
      finite(s.updates) &&
      Number.isInteger(s.updates) &&
      s.updates > 0 &&
      [s.cpuFrameCpuMs, s.cpuFrameKInstructions, s.frameMs].every((v) => finite(v) && v > 0),
  );
  const tail = eligible.slice(-last);
  if (!tail.length) return { skipped };
  const medians: IDesktopFrames["medians"] = {};
  for (const key of PLAYER_KEYS) {
    const m = median(tail.map((s) => s[key]).filter(finite));
    if (m !== undefined) medians[key] = m;
  }
  const frameP95 = percentile(tail.map((s) => s.frameMs).filter(finite), 0.95);
  const claimsWorldWork = tail.some((s) =>
    [
      "worldVisitCounterVersion",
      "worldWorkVisitsTotal",
      ...WORLD_WORK_PARTS,
      ...WORLD_WORK_V3_PARTS,
    ].some((key) => key in s),
  );
  const version = tail[0]?.worldVisitCounterVersion;
  const validWorldWork = tail.every((s) => {
    const parts = [...WORLD_WORK_PARTS, ...(version === 3 ? WORLD_WORK_V3_PARTS : [])].map(
      (key) => s[key],
    );
    return (
      (version === 2 || version === 3) &&
      s.worldVisitCounterVersion === version &&
      (version === 3 || WORLD_WORK_V3_PARTS.every((key) => !(key in s))) &&
      [...parts, s.worldWorkVisitsTotal].every(
        (v) => finite(v) && Number.isSafeInteger(v) && v >= 0,
      ) &&
      (parts as number[]).reduce((sum, v) => sum + v, 0) === s.worldWorkVisitsTotal
    );
  });
  const totals = validWorldWork ? tail.map((s) => s.worldWorkVisitsTotal as number) : [];
  return {
    skipped,
    frames: {
      n: tail.length,
      eligible: eligible.length,
      excluded: values.length - eligible.length,
      medians,
      ...(frameP95 === undefined ? {} : { frameP95 }),
      ...(validWorldWork
        ? {
            worldWork: {
              version: version as 2 | 3,
              n: tail.length,
              median: median(totals) as number,
              max: Math.max(...totals),
            },
          }
        : claimsWorldWork
          ? { worldWorkInvalid: true as const }
          : {}),
    },
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

export const CPU_POSES = {
  takeoff: "released-stick-climb",
  cockpit: "canopy-and-instruments",
  reargun: "gun-view",
} as const;
export type ICpuWindow = import("../../packages/playtest/src/runner/linuxCpuWindow.js").ICpuWindow;

/** Only a successful terminal report establishes acquisition, never an earlier log message. */
export function terminalReport(log: string) {
  const start = [...log.matchAll(/^\{/gm)].at(-1)?.index;
  if (start === undefined || objectEnd(log, start) !== log.trimEnd().length) return undefined;
  try {
    const report = JSON.parse(log.slice(start));
    return typeof report.scenario === "string" &&
      typeof report.url === "string" &&
      (report.runtime === "web" || (report.runtime === "native" && report.target === "desktop")) &&
      report.pass === true &&
      Array.isArray(report.assertionResults) &&
      report.assertionResults.length > 0 &&
      report.assertionResults.every((a: { pass?: unknown } | null) => a?.pass === true)
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}

/** The first error of a failed terminal report, for display only: a failed run never gains a measurement from it. */
export function failureOf(log: string): string | undefined {
  const start = [...log.matchAll(/^\{/gm)].at(-1)?.index;
  if (start === undefined || objectEnd(log, start) !== log.trimEnd().length) return undefined;
  try {
    const report = JSON.parse(log.slice(start));
    if (report.pass !== false) return undefined;
    const first = (Array.isArray(report.diagnostics) ? report.diagnostics : []).find(
      (d: { severity?: unknown; message?: unknown } | null) =>
        d?.severity === "error" && typeof d.message === "string",
    );
    return typeof first?.message === "string"
      ? first.message.replace(/\s+/g, " ").trim().slice(0, 240)
      : "failed without an error diagnostic";
  } catch {
    return undefined;
  }
}

/** Reconcile native completed renders against labelled ticks; never guess missing boundaries. */
export function nativeWindowCompletion(log: string): "unavailable" | "reconciled" | "invalid" {
  const report = terminalReport(log);
  const console = report?.observations?.console;
  const source = Array.isArray(console)
    ? console.map((entry) => entry?.text ?? "").join("\n")
    : log;
  const text = source.includes("TN_PLAYER_FRAME:") ? source : log;
  const frames = scanJson<{ tick: number; updates: number }>(text, "TN_PLAYER_FRAME:");
  if (!frames.values.length && !frames.skipped) return "unavailable";
  if (frames.skipped) return "invalid";
  const windows = report?.acquisition?.cpuWindows;
  if (!Array.isArray(windows) || windows.length !== 3) return "invalid";
  // The host brackets each window in its own ticks (TN_PLAYER_RENDER_HOLD); the runner's window ticks
  // come from the game clock, which can lead the driven tick, so frames are reconciled per bracket.
  const flat = text.includes('\\"') ? text.replaceAll('\\"', '"') : text;
  const events: { at: number; held?: unknown; tick: unknown; updates?: unknown }[] = [];
  for (const marker of ["TN_PLAYER_FRAME:", "TN_PLAYER_RENDER_HOLD:"]) {
    for (let at = flat.indexOf(marker); at !== -1; at = flat.indexOf(marker, at + marker.length)) {
      const begin = at + marker.length;
      const end = objectEnd(flat, begin);
      if (flat[begin] !== "{" || end === -1) return "invalid";
      try {
        events.push({ at, ...JSON.parse(flat.slice(begin, end)) });
      } catch {
        return "invalid";
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  const brackets: { start: number; end: number; ticks: unknown[]; updates: unknown[] }[] = [];
  let open: { start: number; ticks: unknown[]; updates: unknown[] } | undefined;
  for (const event of events) {
    if (event.held === undefined) {
      open?.ticks.push(event.tick);
      open?.updates.push(event.updates);
      continue;
    }
    if (
      typeof event.held !== "boolean" ||
      !Number.isSafeInteger(event.tick) ||
      (event.tick as number) < 0
    )
      return "invalid";
    if (event.held === (open !== undefined)) return "invalid";
    if (event.held) open = { start: event.tick as number, ticks: [], updates: [] };
    else if (open) {
      brackets.push({ ...open, end: event.tick as number });
      open = undefined;
    }
  }
  if (open || brackets.length !== windows.length) return "invalid";
  for (const { start, end, ticks, updates } of brackets) {
    if (
      end - start !== PLAYER_FRAME_WINDOW ||
      ticks.length !== PLAYER_FRAME_WINDOW ||
      ticks.some((tick, i) => tick !== start + i + 1) ||
      updates.some((n) => n !== 1)
    )
      return "invalid";
  }
  return "reconciled";
}

/** Invalid or incomplete OS counters never fall back to frame wall time. */
export function matchedCpuWindows(log: string): ICpuWindow[] | undefined {
  const report = terminalReport(log);
  const windows = report?.acquisition?.cpuWindows;
  if (report?.clock !== "fixed-step" || !Array.isArray(windows) || windows.length !== 3)
    return undefined;
  const positive = (n: unknown) => finite(n) && n > 0;
  const identity = (n: unknown) => positive(n) && Number.isSafeInteger(n);
  for (const label of Object.values(CPU_POSES)) {
    const matches = windows.filter((w) => w?.label === label);
    const w = matches[0];
    if (
      matches.length !== 1 ||
      "profile" in w ||
      ![w.startTick, w.endTick].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      w.endTick - w.startTick !== PLAYER_FRAME_WINDOW ||
      !Array.isArray(w.host?.load) ||
      w.host.load.length !== 3 ||
      !w.host.load.every((n: unknown) => finite(n) && n >= 0) ||
      !w.host?.governors ||
      typeof w.host.governors !== "object" ||
      Array.isArray(w.host.governors) ||
      !Object.entries(w.host.governors).every(
        ([policy, governor]) =>
          /^policy\d+$/u.test(policy) && typeof governor === "string" && governor.trim().length > 0,
      ) ||
      typeof w.mainThread?.starttime !== "string" ||
      !/^\d+$/u.test(w.mainThread.starttime) ||
      !Number.isSafeInteger(w.mainThread?.cpuNs) ||
      w.mainThread.cpuNs <= 0 ||
      w.mainThread.cpuMs !== w.mainThread.cpuNs / 1e6 ||
      w.mainThread.cpuMsPerFrame !== w.mainThread.cpuMs / PLAYER_FRAME_WINDOW ||
      w.mainThread.instructionsPerFrame !== w.mainThread.instructions / PLAYER_FRAME_WINDOW ||
      w.mainThread.cyclesPerFrame !== w.mainThread.cycles / PLAYER_FRAME_WINDOW ||
      ![w.frames, w.updates, w.renders].every((n) => n === PLAYER_FRAME_WINDOW) ||
      ![
        w.mainThread?.cpuMs,
        w.mainThread?.instructions,
        w.mainThread?.cycles,
        w.processTree?.cpuMs,
      ].every(positive) ||
      ![
        w.mainThread?.pid,
        w.mainThread?.tid,
        w.mainThread?.instructions,
        w.mainThread?.cycles,
      ].every(identity) ||
      !Array.isArray(w.processTree?.pids) ||
      !w.processTree.pids.length ||
      !w.processTree.pids.every(identity) ||
      new Set(w.processTree.pids).size !== w.processTree.pids.length ||
      !w.processTree.pids.includes(w.mainThread.pid)
    )
      return undefined;
  }
  const completion = nativeWindowCompletion(log);
  return completion === "invalid" || (report.runtime === "native" && completion !== "reconciled")
    ? undefined
    : windows;
}

export interface IMidwayRun {
  dir: string;
  /** Pins every input used to score this run, including parity and optional cull proof. */
  evidenceSha256?: string;
  tag: string;
  /** The tag without its trailing run number: `walk-a1` and `walk-a2` are group `walk-a`. */
  group: string;
  arm: Arm;
  mtimeMs: number;
  /** Profiler or native diagnostic instrumentation attached: measurements are excluded from scores. */
  profiled?: true;
  /** Raw readings remain visible, but a known measurement conflict excludes this run from scores. */
  timingExclusion?: string;
  /** Explicit failed keep rule; raw readings remain visible but cannot score or win. */
  rejection?: string;
  /** Explicit retained measured reference; does not qualify or promote a winner. */
  retention?: string;
  /** The build that ran it: the `pkg-<name>` directory of the player path in the log (desktop runs). */
  pkg?: string;
  /** `no samples` when the log held none; `ok` otherwise. */
  status: "ok" | "no samples";
  /** The run's own terminal error when it failed; display only, never a measurement. */
  failure?: string;
  desktop?: IDesktopFrames;
  budget?: IBudget;
  /** Runner clock acquisition for this run: `wall-clock` or `fixed-step`, from the run report. */
  clock?: "fixed-step" | "wall-clock";
  engineCommit?: string;
  cpuWindows?: ICpuWindow[];
  /** Exploratory application callback/present intervals; never a qualified CPU or scanout metric. */
  completionWindow?: {
    label: string;
    clock: "wall-clock";
    source: "present-return" | "render-callback-return";
    durationMs: number;
    intervalCount: number;
    completionIntervalP50Ms: number;
  };
  nativeCompletion?: "unavailable" | "reconciled" | "invalid";
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
  const report = terminalReport(log);
  const completion = report?.acquisition?.completionWindow;
  const completionWindow: IMidwayRun["completionWindow"] =
    report?.clock === "wall-clock" &&
    completion?.metric === "application-completion-interval" &&
    completion.clock === "wall-clock" &&
    typeof completion.label === "string" &&
    completion.label.length > 0 &&
    completion.source === (arm === "desktop" ? "present-return" : "render-callback-return") &&
    ((completion.source === "present-return" && completion.timebase === "steady-clock-ms") ||
      (completion.source === "render-callback-return" &&
        completion.timebase === "performance-now-ms")) &&
    finite(completion.completionIntervalP50Ms) &&
    completion.completionIntervalP50Ms > 0 &&
    finite(completion.durationMs) &&
    completion.durationMs >= 5000 &&
    Number.isSafeInteger(completion.intervalCount) &&
    completion.intervalCount >= 100
      ? {
          label: completion.label,
          clock: "wall-clock",
          source: completion.source,
          durationMs: completion.durationMs,
          intervalCount: completion.intervalCount,
          completionIntervalP50Ms: completion.completionIntervalP50Ms,
        }
      : undefined;
  const clock =
    report && (report.clock === "fixed-step" || report.clock === "wall-clock")
      ? (report.clock as IMidwayRun["clock"])
      : undefined;
  const provenance =
    /^arm=(legacy|native|desktop) buildMode=(production|desktop-bundle) engineCommit=([a-f0-9]{40})$/m.exec(
      log,
    );
  const engineCommit = provenance?.[1] === arm ? provenance[3] : undefined;
  const cpuWindows =
    report?.runtime === (arm === "desktop" ? "native" : "web") ? matchedCpuWindows(log) : undefined;
  const pkg = /\/((?:pkg|player)-[\w.-]+)\/tn-native-engine-player-v8/.exec(log)?.[1];
  const desktop = "frames" in player ? player.frames : undefined;
  const failure = failureOf(log);
  const run: IMidwayRun = {
    dir,
    evidenceSha256: createHash("sha256")
      .update(JSON.stringify([log, parityText, cullText]))
      .digest("hex"),
    tag,
    group: tag.replace(/\d+$/, "") || tag,
    arm,
    mtimeMs,
    status: desktop || budget.budget || cpuWindows || completionWindow ? "ok" : "no samples",
    skipped: player.skipped + budget.skipped + ui.skipped,
    ...(failure ? { failure } : {}),
    ...(desktop ? { desktop } : {}),
    ...(budget.budget ? { budget: budget.budget } : {}),
    ...(clock ? { clock } : {}),
    ...(engineCommit ? { engineCommit } : {}),
    ...(cpuWindows ? { cpuWindows, nativeCompletion: nativeWindowCompletion(log) } : {}),
    ...(completionWindow ? { completionWindow } : {}),
    ...(completion === undefined
      ? {}
      : {
          timingExclusion: "Exploratory application-completion window; excluded from qualification",
        }),
    ...("ui" in ui ? { ui: ui.ui } : {}),
    ...(matrix ? { matrix } : {}),
    ...(parity ? { parity } : {}),
    ...(cullPct === undefined ? {} : { cullPct }),
    ...(pkg ? { pkg } : {}),
    ...(tag.startsWith("perf-") ||
    /\bTN_AC3_(?:RIG|WALK|ROOT):/.test(log) ||
    (Array.isArray(report?.acquisition?.cpuWindows) &&
      report.acquisition.cpuWindows.some(
        (window: unknown) => typeof window === "object" && window !== null && "profile" in window,
      ))
      ? { profiled: true as const }
      : {}),
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

/**
 * True when `host-load.txt` (written by flight.sh: `cores N`, then `load X` before and after the run)
 * shows a 1-minute load above three quarters of the cores: other work then slows the run's frame.
 * A run without the file, or with a malformed one, counts as not loaded.
 */
export function loadedHost(text: string | undefined): boolean {
  if (!text) return false;
  const cores = Number(/^cores (\d+)$/m.exec(text)?.[1]);
  const loads = [...text.matchAll(/^load ([\d.]+)$/gm)].map((m) => Number(m[1]));
  if (!(cores > 0) || loads.length === 0) return false;
  return Math.max(...loads) > cores * 0.75;
}

/**
 * Every `<tag>-<arm>` directory under the runs dir, oldest first. Other entries are ignored, and so
 * is a profiled run (a sibling `<tag>.perf.data` or `<tag>.cpuprofile`): the profiler slows it.
 * So is a run flown on a loaded host (see `loadedHost`).
 */
export async function loadMidwayRuns(root = runsDir()): Promise<IMidwayRun[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((e) => e.name));
  const runs: IMidwayRun[] = [];
  for (const entry of entries) {
    const m = /^(.+)-(legacy|native|desktop)$/.exec(entry.name);
    const profiled = m && (names.has(`${m[1]}.perf.data`) || names.has(`${m[1]}.cpuprofile`));
    const loaded =
      m &&
      loadedHost(
        await readFile(path.join(root, entry.name, "host-load.txt"), "utf8").catch(() => undefined),
      );
    const run =
      entry.isDirectory() && m && !profiled && !loaded
        ? await readRun(root, entry.name, m[1] as string, m[2] as Arm)
        : undefined;
    if (run) {
      const [exclusion, rejection, retention] = await Promise.all(
        ["timing-exclusion.txt", "rejected.txt", "retained.txt"].map((file) =>
          readFile(path.join(root, entry.name, file), "utf8").catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }),
        ),
      );
      runs.push({
        ...run,
        ...(exclusion === undefined
          ? {}
          : { timingExclusion: exclusion.trim() || "Timing excluded" }),
        ...(rejection === undefined
          ? {}
          : { rejection: rejection.trim() || "Rejected experiment" }),
        ...(retention === undefined
          ? {}
          : {
              retention: retention.trim() || "Retained measured reference; not a qualified winner",
            }),
      });
    }
  }
  return runs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.dir.localeCompare(b.dir));
}
