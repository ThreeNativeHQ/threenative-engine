/**
 * PRD-610 scoring for the Midway tab: KPI progress from the first recorded run to the target,
 * trends with their target lines, A/B pairs with the keep rule, and the PRD's ticked AC boxes.
 * Fail closed: no data is `pending`, never `pass`, and a missing PRD file reports no progress.
 */
import { readFile } from "node:fs/promises";
import { cyclesOf } from "./cycle.js";
import {
  ARMS,
  type Arm,
  CPU_POSES,
  type IMidwayRun,
  PLAYER_FRAME_WINDOW,
  finite,
  loadMidwayRuns,
  median,
  runsDir,
} from "./dashboard.js";

export const POSES = ["takeoff", "cockpit", "reargun"] as const;
/** PRD-610 targets. */
export const TARGETS = {
  cullPct: 2,
  hudP95Ms: 16.7,
  matrixVisited: 1500,
  ratio: 2,
  /** Native desktop stretch goal; web Wasm has its own, lower target. */
  stretchRatio: 3,
  wasmRatio: 1.5,
} as const;
const PRD = new URL(
  "../../docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md",
  import.meta.url,
);

export type Verdict = "pass" | "fail" | "pending";

/** Historical diagnostics only: native CPU and browser wall/budget readings have different scopes. */
export const mainThreadMs = (run: IMidwayRun) =>
  run.arm === "desktop"
    ? run.desktop?.medians.cpuFrameCpuMs
    : run.clock === "wall-clock"
      ? run.budget?.frameP50
      : undefined;

/** The legacy reference: median over every legacy run that has a frame time. */
export const legacyMs = (runs: readonly IMidwayRun[]) =>
  median(
    runs
      .filter((r) => r.arm === "legacy")
      .map(mainThreadMs)
      .filter(finite),
  );

/** Per-pose paired OS measurements, grouped by engine commit and candidate build. */
export function matchedOf(runs: readonly IMidwayRun[], arm: Arm = "desktop") {
  const eligible = runs.filter(
    (r) =>
      r.engineCommit &&
      r.clock === "fixed-step" &&
      r.cpuWindows &&
      !r.profiled &&
      !r.timingExclusion &&
      !r.rejection &&
      !r.skipped,
  );
  const candidates = eligible.filter((r) => r.arm === arm);
  const latest = [...candidates].sort((a, b) => a.mtimeMs - b.mtimeMs).at(-1);
  const native = latest
    ? candidates.filter(
        (r) => r.engineCommit === latest.engineCommit && buildOf(r) === buildOf(latest),
      )
    : [];
  const legacy = latest
    ? eligible.filter((r) => r.arm === "legacy" && r.engineCommit === latest.engineCommit)
    : [];
  const sequence = [...legacy, ...native].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const pairs: [IMidwayRun, IMidwayRun][] = [];
  for (let i = 0; i + 1 < sequence.length; i++) {
    const a = sequence[i] as IMidwayRun;
    const b = sequence[i + 1] as IMidwayRun;
    if (a.arm === "legacy" && b.arm === arm && a.mtimeMs < b.mtimeMs) {
      pairs.push([a, b]);
      i++;
    }
  }
  const pairedSequence = pairs.length
    ? sequence.slice(sequence.indexOf(pairs[0]?.[0] as IMidwayRun))
    : [];
  const alternating =
    pairedSequence.length === pairs.length * 2 &&
    new Set(pairedSequence.map((r) => r.dir)).size === pairedSequence.length;
  const independent = [...runs]
    .filter((r) => !r.profiled && !r.timingExclusion && !r.rejection && !r.skipped)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return POSES.map((pose) => {
    const readings = pairs
      .map(([a, b]) => {
        const window = (r: IMidwayRun) => r.cpuWindows?.find((w) => w.label === CPU_POSES[pose]);
        const x = window(a);
        const y = window(b);
        return x && y
          ? {
              legacy: a.dir,
              native: b.dir,
              ratio: x.mainThread.cpuMs / y.mainThread.cpuMs,
              legacyCpuMs: x.mainThread.cpuMs / 1000,
              nativeCpuMs: y.mainThread.cpuMs / 1000,
              legacyInstructions: x.mainThread.instructions / 1000,
              nativeInstructions: y.mainThread.instructions / 1000,
              legacyCycles: x.mainThread.cycles / 1000,
              nativeCycles: y.mainThread.cycles / 1000,
              legacyIpc: x.mainThread.instructions / x.mainThread.cycles,
              nativeIpc: y.mainThread.instructions / y.mainThread.cycles,
              legacyTreeCpuMs: x.processTree.cpuMs / 1000,
              nativeTreeCpuMs: y.processTree.cpuMs / 1000,
            }
          : undefined;
      })
      .filter((r) => r !== undefined);
    const parityIssue = pairs.map(([, r]) => parityNote([r])).find((note) => note);
    const parity = pairs.length > 0 && !parityIssue;
    const qualified = readings.length >= 3 && alternating && parity;
    const observed = (r: IMidwayRun) =>
      r.engineCommit && r.clock === "fixed-step" && !r.failure
        ? r.cpuWindows?.find((w) => w.label === CPU_POSES[pose])
        : undefined;
    const reading = (r: IMidwayRun | undefined) => {
      const w = r && observed(r);
      return r && w
        ? {
            run: r.dir,
            commit: r.engineCommit,
            cpuMs: w.mainThread.cpuMs / 1000,
            instructions: w.mainThread.instructions / 1000,
            treeCpuMs: w.processTree.cpuMs / 1000,
          }
        : undefined;
    };
    const provisionalLegacy = !readings.length
      ? independent.find((r) => r.arm === "legacy" && observed(r))
      : undefined;
    const provisionalNative = provisionalLegacy
      ? independent.find((r) => r.arm === arm && (r.failure || observed(r)))
      : undefined;
    const unpaired = provisionalLegacy
      ? {
          legacy: reading(provisionalLegacy),
          native: reading(provisionalNative),
          nativeState: provisionalNative?.failure
            ? "failed"
            : provisionalNative
              ? "measured"
              : "missing",
          note: `PROVISIONAL: independent readings; legacy ${provisionalLegacy.dir} (${provisionalLegacy.engineCommit}); ${provisionalNative ? `${arm} ${provisionalNative.dir}${provisionalNative.failure ? `: ${provisionalNative.failure}` : " measured"} (${provisionalNative.engineCommit ?? "unknown commit"})` : `${arm} missing`}; no paired ratio.`,
        }
      : undefined;
    return {
      pose,
      arm,
      engineCommit: latest?.engineCommit,
      build: latest && buildOf(latest),
      pairs: readings.length,
      qualified,
      parity,
      parityIssue,
      ratio: median(readings.map((r) => r.ratio)),
      legacyCpuMs: median(readings.map((r) => r.legacyCpuMs)),
      nativeCpuMs: median(readings.map((r) => r.nativeCpuMs)),
      legacyInstructions: median(readings.map((r) => r.legacyInstructions)),
      nativeInstructions: median(readings.map((r) => r.nativeInstructions)),
      legacyCycles: median(readings.map((r) => r.legacyCycles)),
      nativeCycles: median(readings.map((r) => r.nativeCycles)),
      legacyIpc: median(readings.map((r) => r.legacyIpc)),
      nativeIpc: median(readings.map((r) => r.nativeIpc)),
      legacyTreeCpuMs: median(readings.map((r) => r.legacyTreeCpuMs)),
      nativeTreeCpuMs: median(readings.map((r) => r.nativeTreeCpuMs)),
      unpaired,
      detail: !readings.length
        ? `pending/unavailable: need matched fixed-step OS windows and matching engine commits${unpaired ? `. ${unpaired.note}` : ""}`
        : `${readings.length} paired windows; ${parity ? "parity PASS" : "native parity missing/FAIL"}; ${qualified ? "three-pair collection gate met; root execution review still required" : "pending qualification: need three alternating pairs per pose"}. Native host completion ${pairs.every(([, r]) => r.nativeCompletion === "reconciled") ? "reconciled" : "unavailable"}; attribution/profiles pending.`,
    };
  });
}

/** A run with a provenance line but no terminal report, written to in the last 20 minutes. */
const RUNNING_WINDOW_MS = 20 * 60 * 1000;
const isRunning = (r: IMidwayRun, now: number) =>
  !!r.engineCommit &&
  !r.clock &&
  !r.failure &&
  !r.cpuWindows &&
  now - r.mtimeMs < RUNNING_WINDOW_MS;

export type HeroState =
  | "qualified"
  | "provisional"
  | "unverified"
  | "failed"
  | "running"
  | "nodata";

/** Every engine commit with a paired, parity-clean ratio for the arm, in run order. */
function ratioHistory(runs: readonly IMidwayRun[], arm: Arm) {
  const commits = new Map<string, number>();
  for (const r of runs)
    if (r.arm === arm && r.cpuWindows && r.engineCommit)
      commits.set(r.engineCommit, Math.max(commits.get(r.engineCommit) ?? 0, r.mtimeMs));
  return [...commits]
    .map(([commit, at]) => ({
      commit,
      at,
      rows: matchedOf(
        runs.filter((r) => r.engineCommit === commit),
        arm,
      ),
    }))
    .filter(({ rows }) => rows.every((p) => p.ratio !== undefined && p.parity))
    .map(({ commit, at, rows }) => ({
      commit,
      at,
      ratios: Object.fromEntries(rows.map((p) => [p.pose, p.ratio as number])),
    }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The top of the Midway tab: per arm, the matched ratio at the current engine commit (the newest
 * legacy run with OS windows). A run from another commit never stands in for a missing one.
 */
export function heroOf(runs: readonly IMidwayRun[], now = Date.now()) {
  const usable = runs.filter((r) => !r.profiled && !r.timingExclusion && !r.rejection);
  const commit = [...usable]
    .filter((r) => r.arm === "legacy" && r.cpuWindows && r.engineCommit)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .at(-1)?.engineCommit;
  const arm = (id: "desktop" | "native") => {
    const target = id === "desktop" ? TARGETS.ratio : TARGETS.wasmRatio;
    const stretch = id === "desktop" ? TARGETS.stretchRatio : undefined;
    const atCommit = commit ? usable.filter((r) => r.engineCommit === commit) : [];
    const mine = atCommit.filter((r) => r.arm === id).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const rows = commit ? matchedOf(atCommit, id) : [];
    const history = ratioHistory(usable, id);
    const previous = history
      .filter((h) => h.commit !== commit && h.at < (mine.at(-1)?.mtimeMs ?? now))
      .at(-1);
    const pairs = rows.length ? Math.min(...rows.map((p) => p.pairs)) : 0;
    const running = mine.some((r) => isRunning(r, now));
    const parityIssue = rows.find((p) => p.parityIssue)?.parityIssue;
    const failure = mine.at(-1)?.failure;
    let state: HeroState;
    let reason: string | undefined;
    if (pairs > 0) {
      state = rows.every((p) => p.qualified)
        ? "qualified"
        : !parityIssue
          ? "provisional"
          : parityIssue === "parity FAIL"
            ? "failed"
            : "unverified";
      reason = parityIssue ? `${parityIssue}; ratios are measured, not qualified` : undefined;
    } else if (running) state = "running";
    else if (failure) {
      state = "failed";
      reason = `${(failure.split("\n")[0] as string).slice(0, 140)}`;
    } else state = "nodata";
    return {
      arm: id,
      target,
      ...(stretch === undefined ? {} : { stretch }),
      state,
      ...(reason ? { reason } : {}),
      running,
      pairs,
      pairsNeeded: 3,
      commit,
      poses: rows.map((p) => {
        const ratio = pairs > 0 ? p.ratio : undefined;
        const prior = previous?.ratios[p.pose];
        return {
          pose: p.pose,
          pairs: p.pairs,
          ratio,
          legacyCpuMs: p.legacyCpuMs,
          nativeCpuMs: p.nativeCpuMs,
          legacyInstructions: p.legacyInstructions,
          nativeInstructions: p.nativeInstructions,
          legacyIpc: p.legacyIpc,
          nativeIpc: p.nativeIpc,
          legacyTreeCpuMs: p.legacyTreeCpuMs,
          nativeTreeCpuMs: p.nativeTreeCpuMs,
          needRatio: ratio === undefined ? undefined : target - ratio,
          needMs:
            ratio === undefined || p.nativeCpuMs === undefined || p.legacyCpuMs === undefined
              ? undefined
              : p.nativeCpuMs - p.legacyCpuMs / target,
          deltaRatio: ratio === undefined || prior === undefined ? undefined : ratio - prior,
        };
      }),
      previousCommit: previous?.commit,
      history,
    };
  };
  return { commit, arms: [arm("desktop"), arm("native")] };
}

/** `- [x] AC-n` against `- [ ] AC-n` in the PRD. No AC boxes at all means no progress, not 0 of 0. */
export function prdProgress(markdown: string) {
  const boxes = [...markdown.matchAll(/^- \[([ xX])\] (AC-\d+)/gm)];
  if (!boxes.length) return undefined;
  const ticked = boxes.filter((m) => m[1] !== " ").map((m) => m[2] as string);
  return {
    done: ticked.length,
    total: boxes.length,
    ticked,
    open: boxes.filter((m) => m[1] === " ").map((m) => m[2] as string),
  };
}

/** Fraction of the way from the baseline to the target; it works for lower- and higher-is-better alike. */
export function progressOf(baseline: number, current: number, target: number): number {
  return baseline === target
    ? current === target
      ? 1
      : 0
    : (current - baseline) / (target - baseline);
}

export interface IKpi {
  id: string;
  title: string;
  verdict: Verdict;
  better: "lower" | "higher";
  unit: string;
  target: number;
  current?: number;
  baseline?: number;
  baselineDeltaPct?: number;
  /** 0 at the baseline, 1 at the target; below 0 is a regression and above 1 is past the target. */
  progress?: number;
  /** The selected build (the one `current` is the median of) and how many runs it has. */
  build?: string;
  runs?: number;
  baselineBuild?: string;
  /** The PRD box for this AC is ticked. */
  ticked?: boolean;
  detail: string;
}

/** Parity of every run in a build: one missing or failed verdict makes the build's note. */
const parityNote = (runs: readonly IMidwayRun[]) =>
  runs.some((r) => !r.parity)
    ? "no parity.json"
    : runs.every((r) => r.parity?.pass && POSES.every((p) => r.parity?.frames[p]?.pass))
      ? undefined
      : "parity FAIL";

const ARM_BUILD = { legacy: "three.js", native: "web Wasm", desktop: "unknown build" } as const;

/** A run's build: its package name, or the arm's own name for arms that carry none. */
export const buildOf = (r: IMidwayRun) => r.pkg ?? ARM_BUILD[r.arm];

interface IMeasure {
  build: string;
  /** The runs of this build that carry the value. */
  runs: IMidwayRun[];
  /** Median over those runs. */
  value: number;
  /** Oldest run time of the build: builds are ordered by it. */
  firstSeen: number;
}

/** One median per build of an arm, oldest build first. */
function measures(
  runs: readonly IMidwayRun[],
  arm: Arm,
  get: (r: IMidwayRun) => number | undefined,
): IMeasure[] {
  const by = new Map<string, { runs: IMidwayRun[]; values: number[] }>();
  for (const r of runs) {
    const v = r.arm === arm ? get(r) : undefined;
    if (v === undefined) continue;
    const e = by.get(buildOf(r)) ?? { runs: [], values: [] };
    e.runs.push(r);
    e.values.push(v);
    by.set(buildOf(r), e);
  }
  return [...by]
    .map(([build, e]) => ({
      build,
      runs: e.runs,
      value: median(e.values) as number,
      firstSeen: Math.min(...e.runs.map((r) => r.mtimeMs)),
    }))
    .sort((x, y) => x.firstSeen - y.firstSeen);
}

/** The oldest and the newest build of an arm that carry a value. */
function ends(runs: readonly IMidwayRun[], arm: Arm, get: (r: IMidwayRun) => number | undefined) {
  const m = measures(runs, arm, get);
  return { first: m[0], last: m.at(-1) };
}

const medOf = (list: readonly IMidwayRun[], get: (r: IMidwayRun) => number | undefined) =>
  median(list.map(get).filter(finite));

export function kpisOf(
  runs: readonly IMidwayRun[],
  prd = prdProgress(""),
  currentRuns = runs,
): IKpi[] {
  const compared = (arm: Arm, get: (r: IMidwayRun) => number | undefined) => ({
    first: ends(runs, arm, get).first,
    last: ends(currentRuns, arm, get).last,
  });
  const make = (
    id: string,
    title: string,
    better: IKpi["better"],
    unit: string,
    target: number,
    { first, last }: { first?: IMeasure; last?: IMeasure },
    detail: (last: IMeasure) => string,
    pass: (last: IMeasure) => boolean,
    why = "no samples",
  ): IKpi => {
    const base = { id, title, better, unit, target, ticked: prd?.ticked.includes(id) ?? false };
    if (!first || !last) return { ...base, verdict: "pending", detail: why };
    return {
      ...base,
      verdict: pass(last) ? "pass" : "fail",
      current: last.value,
      baseline: first.value,
      baselineDeltaPct:
        first.value === 0 ? undefined : ((last.value - first.value) / Math.abs(first.value)) * 100,
      progress: progressOf(first.value, last.value, target),
      build: last.build,
      runs: last.runs.length,
      baselineBuild: first.build,
      detail: detail(last),
    };
  };
  const ratioKpi = (id: string, title: string, arm: Arm, target: number) => {
    const poses = matchedOf(currentRuns, arm);
    const provisional = matchedOf(runs, arm);
    const complete = poses.every((p) => p.qualified && p.ratio !== undefined);
    const current = poses.every((p) => p.ratio !== undefined)
      ? Math.min(...poses.map((p) => p.ratio as number))
      : undefined;
    return {
      id,
      title,
      better: "higher" as const,
      unit: "x",
      target,
      ticked: prd?.ticked.includes(id) ?? false,
      verdict: !complete
        ? ("pending" as const)
        : poses.every((p) => (p.ratio as number) >= target)
          ? ("pending" as const)
          : ("fail" as const),
      ...(current === undefined ? {} : { current }),
      detail: `AC15 measures matched CPU; AC19 free-run/display/visual proof pending. ${poses.map((p, i) => `${p.pose}: ${p.ratio === undefined ? "unavailable" : `${p.ratio.toFixed(3)}x`} · ${!p.pairs && provisional[i]?.unpaired ? provisional[i].detail : p.detail}`).join("; ")}`,
    };
  };
  return [
    make(
      "AC-3",
      "Matrix walk",
      "lower",
      "nodes",
      TARGETS.matrixVisited,
      compared("desktop", (r) => r.matrix?.last),
      (l) => `last ${l.value}, max ${Math.max(...l.runs.map((r) => r.matrix?.max ?? 0))}`,
      (l) => l.value <= TARGETS.matrixVisited,
    ),
    make(
      "AC-4",
      "Cull share of main thread",
      "lower",
      "%",
      TARGETS.cullPct,
      compared("desktop", (r) => r.cullPct),
      () => "ProjectedCull::apply share, from cull.json",
      (l) => l.value < TARGETS.cullPct,
      'no samples: write cull.json {"sharePct": n} into a desktop run dir',
    ),
    make(
      "AC-5",
      "HUD round trip p95",
      "lower",
      "ms",
      TARGETS.hudP95Ms,
      compared("desktop", (r) => r.ui?.p95),
      (l) => `p50 ${medOf(l.runs, (r) => r.ui?.p50)?.toFixed(1)} ms, p95 ${l.value.toFixed(1)} ms`,
      (l) => l.value < TARGETS.hudP95Ms,
    ),
    ratioKpi("AC-19", "Desktop speed vs three.js", "desktop", TARGETS.ratio),
    ratioKpi("AC-7", "Web Wasm vs three.js", "native", TARGETS.wasmRatio),
  ];
}

/** One point per build: the median over that build's runs. */
export interface ITrendPoint {
  build: string;
  arm: Arm;
  v: number;
  runs: number;
  decision: "retained" | "rejected" | "pending";
  decisionReason: string;
}
export interface ITrend {
  id: string;
  title: string;
  unit: string;
  target?: number;
  targetLabel: string;
  points: ITrendPoint[];
  /** Benchmark lines: the three.js (legacy) median and the latest web Wasm value, when they have one. */
  benchmarks: { arm: Arm; label: string; value: number }[];
  /** Percent better than the first desktop build (positive is better; every trend is lower-is-better). */
  deltaPct?: number;
}

function benchmarksOf(runs: readonly IMidwayRun[], get: (r: IMidwayRun) => number | undefined) {
  const legacy = median(
    runs
      .filter((r) => r.arm === "legacy")
      .map(get)
      .filter(finite),
  );
  const wasm = ends(runs, "native", get).last?.value;
  return [
    ...(legacy === undefined ? [] : [{ arm: "legacy" as const, label: "three.js", value: legacy }]),
    ...(wasm === undefined ? [] : [{ arm: "native" as const, label: "web Wasm", value: wasm }]),
  ];
}

export function trendsOf(runs: readonly IMidwayRun[], history = runs): ITrend[] {
  const scored = runs.filter((r) => !r.rejection);
  const legacy = legacyMs(scored);
  const trend = (
    id: string,
    title: string,
    unit: string,
    target: number | undefined,
    targetLabel: string,
    get: (r: IMidwayRun) => number | undefined,
  ): ITrend => {
    const points = ARMS.flatMap((arm) => measures(history, arm, get))
      .sort((x, y) => x.firstSeen - y.firstSeen)
      .map((m): ITrendPoint => {
        const retained = m.runs.every((r) => r.retention && !r.rejection);
        const rejected = m.runs.every((r) => r.rejection);
        const mixed = !retained && !rejected && m.runs.some((r) => r.retention || r.rejection);
        return {
          build: m.build,
          arm: m.runs[0]?.arm as Arm,
          v: m.value,
          runs: m.runs.length,
          decision: retained ? "retained" : rejected ? "rejected" : "pending",
          decisionReason:
            (mixed ? "Mixed outcomes; not all runs retained. " : "") +
            m.runs
              .map(
                (r) =>
                  `${r.dir}: ${r.rejection ? `REJECTED: ${r.rejection}` : r.retention ? `RETAINED: ${r.retention}` : "PENDING: no explicit decision"}${r.timingExclusion ? `; timing excluded: ${r.timingExclusion}` : ""}`,
              )
              .join("\n"),
        };
      });
    const benchmarks = benchmarksOf(scored, get);
    const desktop = measures(scored, "desktop", get);
    const first = desktop[0]?.value;
    const last = desktop.at(-1)?.value;
    return {
      id,
      title,
      unit,
      targetLabel,
      points,
      benchmarks,
      ...(target === undefined ? {} : { target }),
      ...(first && last !== undefined && desktop.length > 1
        ? { deltaPct: ((first - last) / first) * 100 }
        : {}),
    };
  };
  return [
    trend(
      "ms",
      "Historical wall/budget and native CPU diagnostics (unmatched)",
      "ms",
      legacy,
      "three.js",
      mainThreadMs,
    ),
    trend("hud", "HUD round trip p95", "ms", TARGETS.hudP95Ms, "target", (r) => r.ui?.p95),
    trend("instr", "Instructions per frame (M)", "M", undefined, "", instrM),
    trend(
      "matrix",
      "Matrix walk visited",
      "nodes",
      TARGETS.matrixVisited,
      "target",
      (r) => r.matrix?.last,
    ),
  ];
}

/** Main-thread user-space instructions per frame in millions: steady on a shared host where ms swings. */
export const instrM = (r: IMidwayRun) => {
  const k = r.desktop?.medians.cpuFrameKInstructions;
  return k === undefined ? undefined : k / 1000;
};

export interface IAbRun {
  dir: string;
  pkg: string;
  ms: number;
  /** Millions of instructions per frame, when the run carries the counter. */
  instr?: number;
  round: number;
}
export interface IAbStep {
  from: string;
  to: string;
  /** Keep rule: every run of `to` beats every run of `from` (lower is better). */
  verdict: "keep" | "reject";
  /** Medians on the decision metric. */
  medianFrom: number;
  medianTo: number;
  msFrom: number;
  msTo: number;
}
export interface IAbPair {
  stem: string;
  arm: Arm;
  /** Instructions per frame when every run of the group carries it, ms per frame otherwise. */
  metric: "instr" | "ms";
  arms: { name: string; runs: IAbRun[] }[];
  /** Consecutive arms compared: `a` then `b`, or `base` then `ac3` then `ac4`. */
  steps: IAbStep[];
  verdict: "keep" | "reject" | "pending";
}

/** `<stem>-<arm><round>` with a one-digit round: `walk-a1`, `instr-base1`, `instr-ac31` (arm `ac3`, round 1). */
const ROTATION = /^(.+)-([a-z][a-z0-9]*)(\d)$/;

/** Arms are alphabetical when they are single letters (`a`, `b`), otherwise in the order they first ran. */
function ordered(arms: { name: string; first: number; runs: IAbRun[] }[]) {
  const letters = arms.every((a) => a.name.length === 1);
  return [...arms].sort((x, y) => (letters ? x.name.localeCompare(y.name) : x.first - y.first));
}

/** Groups runs by `<stem>-<arm><round>` tags and applies the keep rule between consecutive arms. */
export function abPairsOf(runs: readonly IMidwayRun[]): IAbPair[] {
  const groups = new Map<
    string,
    { stem: string; arm: Arm; arms: Map<string, { name: string; first: number; runs: IAbRun[] }> }
  >();
  for (const r of runs) {
    const m = ROTATION.exec(r.tag);
    const ms = mainThreadMs(r);
    if (!m || ms === undefined) continue;
    const g = groups.get(`${m[1]}\0${r.arm}`) ?? {
      stem: m[1] as string,
      arm: r.arm,
      arms: new Map(),
    };
    const arm = g.arms.get(m[2] as string) ?? { name: m[2] as string, first: r.mtimeMs, runs: [] };
    const instr = instrM(r);
    arm.first = Math.min(arm.first, r.mtimeMs);
    arm.runs.push({
      dir: r.dir,
      pkg: buildOf(r),
      ms,
      round: Number(m[3]),
      ...(instr === undefined ? {} : { instr }),
    });
    g.arms.set(arm.name, arm);
    groups.set(`${m[1]}\0${r.arm}`, g);
  }
  return [...groups.values()].map((g) => {
    const arms = ordered([...g.arms.values()]);
    const metric = arms.every((a) => a.runs.every((r) => r.instr !== undefined)) ? "instr" : "ms";
    const val = (r: IAbRun) => (metric === "instr" ? (r.instr as number) : r.ms);
    const steps = arms.slice(1).map((to, i): IAbStep => {
      const from = arms[i] as (typeof arms)[number];
      const [f, t] = [from.runs.map(val), to.runs.map(val)];
      return {
        from: from.name,
        to: to.name,
        verdict: Math.max(...t) < Math.min(...f) ? "keep" : "reject",
        medianFrom: median(f) as number,
        medianTo: median(t) as number,
        msFrom: median(from.runs.map((r) => r.ms)) as number,
        msTo: median(to.runs.map((r) => r.ms)) as number,
      };
    });
    return {
      stem: g.stem,
      arm: g.arm,
      metric,
      arms: arms.map((a) => ({ name: a.name, runs: a.runs })),
      steps,
      verdict: !steps.length
        ? "pending"
        : steps.some((s) => s.verdict === "reject")
          ? "reject"
          : "keep",
    };
  });
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
  pkgs: string[];
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
      pkgs: [...new Set(list.map(buildOf))],
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

/** Newest desktop build's frame split (median over its runs): game JS, render, other main-thread work, and the present call. */
export function breakdownOf(runs: readonly IMidwayRun[]) {
  const last = ends(runs, "desktop", (r) => r.desktop?.medians.cpuFrameCpuMs).last;
  if (!last) return undefined;
  const key = (k: "gameJsCpuMs" | "renderCpuMs" | "presentCpuMs") =>
    medOf(last.runs, (r) => r.desktop?.medians[k]) ?? 0;
  const gameJs = key("gameJsCpuMs");
  const render = key("renderCpuMs");
  return {
    build: last.build,
    runs: last.runs.length,
    gameJs,
    render,
    other: Math.max(0, last.value - gameJs - render),
    present: key("presentCpuMs"),
  };
}

export interface IGapSide {
  ms: number;
  absMs: number;
  /** Percent of the three.js time: positive is slower, negative is faster. */
  pct: number;
  direction: "slower" | "faster" | "equal";
  build: string;
  runs: number;
}

/** Desktop native and web Wasm against three.js on main-thread ms per frame, newest build of each (median over its runs). */
export function gapOf(runs: readonly IMidwayRun[]) {
  const side = (arm: Arm): IGapSide | undefined => {
    const poses = matchedOf(runs, arm);
    if (!poses.every((p) => p.qualified)) return undefined;
    const ms = median(poses.map((p) => p.nativeCpuMs).filter(finite));
    const legacy = median(poses.map((p) => p.legacyCpuMs).filter(finite));
    if (ms === undefined || legacy === undefined) return undefined;
    const absMs = ms - legacy;
    return {
      ms,
      absMs,
      pct: (absMs / legacy) * 100,
      direction: absMs > 0 ? "slower" : absMs < 0 ? "faster" : "equal",
      build: poses[0]?.build ?? "unknown",
      runs: poses[0]?.pairs ?? 0,
    };
  };
  const desktop = side("desktop");
  const wasm = side("native");
  return {
    legacyMs:
      desktop || wasm
        ? median(
            matchedOf(runs, desktop ? "desktop" : "native")
              .map((p) => p.legacyCpuMs)
              .filter(finite),
          )
        : undefined,
    desktop,
    wasm,
  };
}

/** Desktop builds, oldest first, each reduced to the median over its runs. */
export function buildsOf(runs: readonly IMidwayRun[]) {
  return measures(runs, "desktop", mainThreadMs).map((m) => ({
    build: m.build,
    firstSeen: m.firstSeen,
    runs: m.runs.length,
    ms: m.value,
    instrM: medOf(m.runs, instrM),
    hudP95: medOf(m.runs, (r) => r.ui?.p95),
    matrixLast: medOf(m.runs, (r) => r.matrix?.last),
    parityPass: m.runs.filter((r) => r.parity?.pass).length,
  }));
}

/** Deliberate promotion only: the reviewer attests controls that historical logs cannot prove.
 * winner-lock.json: { package, qualification: { reviewedBy, isolated, sameWorkload, sameHud,
 * sameEnvironment }, baseline: [{ dir, evidenceSha256 }], candidate: [{ dir, evidenceSha256 }] }.
 * Arrays list alternating baseline/candidate rounds; hashes come from the raw runs API.
 */
export function winnerOf(runs: readonly IMidwayRun[], text?: string) {
  const fail = (reason: string) => ({
    status: "unqualified" as const,
    reason,
    runs: [] as IMidwayRun[],
  });
  if (text === undefined) return fail("No winner-lock.json; latest builds are experimental.");
  try {
    const lock = JSON.parse(text);
    const q = lock.qualification;
    if (
      typeof lock.package !== "string" ||
      !lock.package.startsWith("pkg-") ||
      typeof q?.reviewedBy !== "string" ||
      !q.reviewedBy.trim() ||
      ![q.isolated, q.sameWorkload, q.sameHud, q.sameEnvironment].every((v) => v === true)
    )
      return fail(
        "Lock needs an explicit reviewer and controlled isolation, workload, HUD and environment approval.",
      );
    if (
      !Array.isArray(lock.baseline) ||
      !Array.isArray(lock.candidate) ||
      lock.baseline.length < 3 ||
      lock.baseline.length !== lock.candidate.length
    )
      return fail("Lock needs at least three complete A/B pairs.");
    const pinned = (entries: { dir: string; evidenceSha256: string }[]) =>
      entries.map((entry) => {
        const run = runs.find((r) => r.dir === entry.dir);
        if (
          !run ||
          run.arm !== "desktop" ||
          run.status !== "ok" ||
          run.skipped ||
          run.profiled ||
          run.timingExclusion ||
          run.rejection ||
          run.desktop?.n !== PLAYER_FRAME_WINDOW ||
          run.desktop.worldWorkInvalid ||
          parityNote([run]) ||
          !/^[a-f0-9]{64}$/.test(entry.evidenceSha256) ||
          entry.evidenceSha256 !== run.evidenceSha256 ||
          !finite(instrM(run)) ||
          !finite(mainThreadMs(run)) ||
          !finite(run.ui?.p95)
        )
          throw new Error(
            "Pinned run is missing, changed, excluded, malformed (including world counters) or lacks 1000 complete active frames, instructions, HUD or passing parity.",
          );
        return run;
      });
    const baseline = pinned(lock.baseline);
    const candidate = pinned(lock.candidate);
    const sequence = baseline.flatMap((r, i) => [r, candidate[i] as IMidwayRun]);
    if (
      new Set(sequence.map((r) => r.dir)).size !== sequence.length ||
      sequence.some((r, i) => i > 0 && r.mtimeMs <= (sequence[i - 1] as IMidwayRun).mtimeMs)
    )
      return fail("Pinned runs must be distinct and alternate baseline then candidate in time.");
    if (
      new Set(baseline.map((r) => r.pkg)).size !== 1 ||
      !baseline[0]?.pkg ||
      baseline[0].pkg === lock.package ||
      candidate.some((r) => r.pkg !== lock.package)
    )
      return fail("Lock must pin one baseline package and one distinct candidate package.");
    const range = (list: IMidwayRun[], get: (r: IMidwayRun) => number | undefined) =>
      list.map(get) as number[];
    if (Math.max(...range(candidate, instrM)) >= Math.min(...range(baseline, instrM)))
      return fail("REJECT: every candidate must beat every baseline on instructions.");
    if (
      Math.max(...range(candidate, mainThreadMs)) > Math.min(...range(baseline, mainThreadMs)) ||
      Math.max(...range(candidate, (r) => r.ui?.p95)) >
        Math.min(...range(baseline, (r) => r.ui?.p95))
    )
      return fail("REJECT: candidate CPU time or HUD p95 regresses against the baseline.");
    return {
      status: "accepted" as const,
      build: lock.package as string,
      reviewedBy: q.reviewedBy as string,
      runs: candidate,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid winner lock.");
  }
}

/** Timing scores exclude diagnostic runs; experimental structural progress can use timing-excluded runs. */
export function midwayOf(
  all: readonly IMidwayRun[],
  prdText?: string,
  lockText?: string,
  now = Date.now(),
  cyclesText?: string,
) {
  const runs = all.filter((r) => !r.profiled && !r.timingExclusion && !r.rejection);
  const prd = prdText === undefined ? undefined : prdProgress(prdText);
  const { runs: accepted, ...winner } = winnerOf(runs, lockText);
  const reference = runs.find(
    (r) => r.dir === "isolated-cache-a1-desktop" && r.pkg === "pkg-ac10-cache-a1",
  );
  // Explicit retained repeats are a measured reference, never winner qualification.
  const retained = [
    "ac3-calibration-20261014T135316Z-t-desktop",
    "ac3-calibration-20261014T135316Z-t2-desktop",
  ].map((dir) =>
    runs.find(
      (r) =>
        r.dir === dir &&
        r.pkg === "pkg-ac3-calibration-20261014T135316Z-t" &&
        !!r.retention &&
        !r.skipped &&
        r.desktop?.n === PLAYER_FRAME_WINDOW &&
        !r.desktop.worldWorkInvalid &&
        !parityNote([r]),
    ),
  );
  const repeatedReference = retained.filter((r): r is IMidwayRun => !!r);
  const pinned = repeatedReference.length === 2 ? repeatedReference : reference ? [reference] : [];
  const measured = accepted.length ? accepted : pinned;
  const headline = [...runs.filter((r) => r.arm === "legacy"), ...measured];
  const structuralRuns = all.filter(
    (r) =>
      r.arm === "desktop" &&
      !!r.pkg?.trim() &&
      r.pkg !== measured[0]?.pkg &&
      !r.profiled &&
      !r.rejection &&
      !r.skipped &&
      r.desktop?.n === PLAYER_FRAME_WINDOW &&
      !r.desktop.worldWorkInvalid &&
      !parityNote([r]) &&
      finite(r.matrix?.last),
  );
  const bestStructural = measures(structuralRuns, "desktop", (r) => r.matrix?.last).sort(
    (a, b) => a.value - b.value,
  )[0];
  const structuralRun = bestStructural?.runs.at(-1);
  const pinnedProjection = medOf(measured, (r) => r.matrix?.last);
  const experimentalAc3 =
    !accepted.length && bestStructural
      ? kpisOf(runs, prd, bestStructural.runs).find((k) => k.id === "AC-3")
      : undefined;
  const experimentalAc4 = !accepted.length
    ? kpisOf(
        runs,
        prd,
        runs.filter(
          (r) =>
            r.arm === "desktop" &&
            !!r.pkg?.trim() &&
            !r.skipped &&
            r.desktop?.n === PLAYER_FRAME_WINDOW &&
            !r.desktop.worldWorkInvalid &&
            !parityNote([r]),
        ),
      ).find((k) => k.id === "AC-4")
    : undefined;
  return {
    hero: heroOf(runs, now),
    cycles: cyclesOf(cyclesText, now),
    matchedCpu: [...matchedOf(runs), ...matchedOf(runs, "native")],
    winner,
    selection: {
      role: accepted.length ? "accepted winner" : "pinned reference / not qualified",
      build: measured[0]?.pkg,
      runs: measured.map((r) => r.dir),
    },
    candidate: {
      kpis: kpisOf(runs, prd),
      gap: gapOf(runs),
      breakdown: breakdownOf(runs),
      structural:
        bestStructural && structuralRun
          ? {
              dir: structuralRun.dir,
              build: bestStructural.build,
              projection: bestStructural.value,
              projections: bestStructural.runs.map((r) => r.matrix?.last as number),
              runs: bestStructural.runs.length,
              runDirs: bestStructural.runs.map((r) => r.dir),
              target: TARGETS.matrixVisited,
              pinnedProjection,
              projectionReductionPct:
                pinnedProjection !== undefined && pinnedProjection > 0
                  ? (1 - bestStructural.value / pinnedProjection) * 100
                  : undefined,
              worldWork: structuralRun.desktop?.worldWork,
              timingExclusion: bestStructural.runs.find((r) => r.timingExclusion)?.timingExclusion,
            }
          : undefined,
    },
    kpis: kpisOf(runs, prd, [...new Set([...headline, ...runs.filter((r) => r.cpuWindows)])]).map(
      (k) =>
        k.id === "AC-3" && experimentalAc3
          ? {
              ...experimentalAc3,
              detail: `experimental · not accepted · ${experimentalAc3.detail}`,
            }
          : k.id === "AC-4" && k.current === undefined && experimentalAc4?.current !== undefined
            ? {
                ...experimentalAc4,
                detail: `measured experimental · not accepted · ${experimentalAc4.detail}`,
              }
            : k,
    ),
    prd,
    trends: trendsOf(
      runs,
      all.filter((r) => !r.profiled && (!r.timingExclusion || r.rejection)),
    ),
    abPairs: abPairsOf(runs),
    breakdown: breakdownOf(headline),
    builds: buildsOf(runs),
    gap: gapOf(runs),
    groups: groupsOf(runs),
    legacyMs: gapOf(runs).legacyMs,
    runs: all,
    skipped: all.reduce((n, r) => n + r.skipped, 0),
    dir: runsDir(),
  };
}

/** Everything the tab shows, read fresh. */
export async function midwayState() {
  return midwayOf(
    await loadMidwayRuns(),
    await readFile(PRD, "utf8").catch(() => undefined),
    await readFile(`${runsDir()}/winner-lock.json`, "utf8").catch((error) =>
      error.code === "ENOENT" ? undefined : "invalid unreadable winner lock",
    ),
    Date.now(),
    await readFile(`${runsDir()}/cycles.jsonl`, "utf8").catch(() => undefined),
  );
}
