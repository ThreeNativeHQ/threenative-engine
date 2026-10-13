/**
 * PRD-610 scoring for the Midway tab: KPI progress from the first recorded run to the target,
 * trends with their target lines, A/B pairs with the keep rule, and the PRD's ticked AC boxes.
 * Fail closed: no data is `pending`, never `pass`, and a missing PRD file reports no progress.
 */
import { readFile } from "node:fs/promises";
import {
  ARMS,
  type Arm,
  type IMidwayRun,
  finite,
  loadMidwayRuns,
  median,
  runsDir,
} from "./dashboard.js";

export const POSES = ["takeoff", "cockpit", "reargun"] as const;
/** PRD-610 targets. */
export const TARGETS = { cullPct: 2, hudP95Ms: 16.7, matrixVisited: 1500, ratio: 1 } as const;
const PRD = new URL(
  "../../docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md",
  import.meta.url,
);

export type Verdict = "pass" | "fail" | "pending";

/** Main-thread ms per frame that every arm reports: desktop `cpuFrameCpuMs`, web `frame.p50`. */
export const mainThreadMs = (run: IMidwayRun) =>
  run.arm === "desktop" ? run.desktop?.medians.cpuFrameCpuMs : run.budget?.frameP50;

/** The legacy reference: median over every legacy run that has a frame time. */
export const legacyMs = (runs: readonly IMidwayRun[]) =>
  median(
    runs
      .filter((r) => r.arm === "legacy")
      .map(mainThreadMs)
      .filter(finite),
  );

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
  /** 0 at the baseline, 1 at the target; below 0 is a regression and above 1 is past the target. */
  progress?: number;
  /** The newest build (the one `current` is the median of) and how many runs it has. */
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

export function kpisOf(runs: readonly IMidwayRun[], prd = prdProgress("")): IKpi[] {
  const legacy = legacyMs(runs);
  const ratio = (r: IMidwayRun) => {
    const ms = mainThreadMs(r);
    return legacy === undefined || ms === undefined ? undefined : legacy / ms;
  };
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
      progress: progressOf(first.value, last.value, target),
      build: last.build,
      runs: last.runs.length,
      baselineBuild: first.build,
      detail: detail(last),
    };
  };
  const ratioKpi = (id: string, title: string, arm: Arm, floor: "above" | "atLeast") => {
    const e = ends(runs, arm, ratio);
    const bad = parityNote(e.last?.runs ?? []);
    return make(
      id,
      title,
      "higher",
      "x",
      TARGETS.ratio,
      e,
      (l) =>
        `${(medOf(l.runs, mainThreadMs) as number).toFixed(2)} ms vs legacy ${(legacy as number).toFixed(2)} ms, ${bad ?? "parity PASS"}. Run level, poses are not separated in the logs.`,
      (l) =>
        bad === undefined &&
        (floor === "above" ? l.value > TARGETS.ratio : l.value >= TARGETS.ratio),
      `no samples: need a ${arm} run and a legacy run`,
    );
  };
  return [
    make(
      "AC-3",
      "Matrix walk",
      "lower",
      "nodes",
      TARGETS.matrixVisited,
      ends(runs, "desktop", (r) => r.matrix?.last),
      (l) => `last ${l.value}, max ${Math.max(...l.runs.map((r) => r.matrix?.max ?? 0))}`,
      (l) => l.value <= TARGETS.matrixVisited,
    ),
    make(
      "AC-4",
      "Cull share of main thread",
      "lower",
      "%",
      TARGETS.cullPct,
      ends(runs, "desktop", (r) => r.cullPct),
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
      ends(runs, "desktop", (r) => r.ui?.p95),
      (l) => `p50 ${medOf(l.runs, (r) => r.ui?.p50)?.toFixed(1)} ms, p95 ${l.value.toFixed(1)} ms`,
      (l) => l.value < TARGETS.hudP95Ms,
    ),
    ratioKpi("AC-6", "Desktop vs three.js", "desktop", "above"),
    ratioKpi("AC-7", "Web Wasm vs three.js", "native", "atLeast"),
  ];
}

/** One point per build: the median over that build's runs. */
export interface ITrendPoint {
  build: string;
  arm: Arm;
  v: number;
  runs: number;
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

export function trendsOf(runs: readonly IMidwayRun[]): ITrend[] {
  const legacy = legacyMs(runs);
  const trend = (
    id: string,
    title: string,
    unit: string,
    target: number | undefined,
    targetLabel: string,
    get: (r: IMidwayRun) => number | undefined,
  ): ITrend => {
    const points = ARMS.flatMap((arm) => measures(runs, arm, get))
      .sort((x, y) => x.firstSeen - y.firstSeen)
      .map(
        (m): ITrendPoint => ({
          build: m.build,
          arm: m.runs[0]?.arm as Arm,
          v: m.value,
          runs: m.runs.length,
        }),
      );
    const benchmarks = benchmarksOf(runs, get);
    const desktop = points.filter((p) => p.arm === "desktop");
    const first = desktop[0]?.v;
    const last = desktop.at(-1)?.v;
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
    trend("ms", "Main-thread ms per frame", "ms", legacy, "three.js", mainThreadMs),
    trend("hud", "HUD round trip p95", "ms", TARGETS.hudP95Ms, "target", (r) => r.ui?.p95),
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

export interface IAbPair {
  stem: string;
  arm: Arm;
  a: { dir: string; pkg: string; ms: number }[];
  b: { dir: string; pkg: string; ms: number }[];
  /** Keep rule: every B beats every A (lower ms per frame). */
  verdict: "keep" | "reject" | "pending";
  medianA?: number;
  medianB?: number;
}

/** Pairs groups named `<stem>-a` and `<stem>-b` of the same arm. */
export function abPairsOf(runs: readonly IMidwayRun[]): IAbPair[] {
  const sides = new Map<string, { stem: string; arm: Arm; a: IAbPair["a"]; b: IAbPair["b"] }>();
  for (const r of runs) {
    const m = /^(.+)-([ab])$/.exec(r.group);
    const ms = mainThreadMs(r);
    if (!m || ms === undefined) continue;
    const key = `${m[1]}\0${r.arm}`;
    const entry = sides.get(key) ?? { stem: m[1] as string, arm: r.arm, a: [], b: [] };
    entry[m[2] as "a" | "b"].push({ dir: r.dir, pkg: buildOf(r), ms });
    sides.set(key, entry);
  }
  return [...sides.values()]
    .filter((s) => s.a.length || s.b.length)
    .map((s) => {
      const [a, b] = [s.a.map((x) => x.ms), s.b.map((x) => x.ms)];
      const ready = a.length > 0 && b.length > 0;
      const mA = median(a);
      const mB = median(b);
      return {
        ...s,
        verdict: !ready ? "pending" : Math.max(...b) < Math.min(...a) ? "keep" : "reject",
        ...(mA === undefined ? {} : { medianA: mA }),
        ...(mB === undefined ? {} : { medianB: mB }),
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
  const legacy = legacyMs(runs);
  const side = (arm: Arm): IGapSide | undefined => {
    const last = ends(runs, arm, mainThreadMs).last;
    if (!last || legacy === undefined) return undefined;
    const absMs = last.value - legacy;
    return {
      ms: last.value,
      absMs,
      pct: (absMs / legacy) * 100,
      direction: absMs > 0 ? "slower" : absMs < 0 ? "faster" : "equal",
      build: last.build,
      runs: last.runs.length,
    };
  };
  return { legacyMs: legacy, desktop: side("desktop"), wasm: side("native") };
}

/** Desktop builds, oldest first, each reduced to the median over its runs. */
export function buildsOf(runs: readonly IMidwayRun[]) {
  return measures(runs, "desktop", mainThreadMs).map((m) => ({
    build: m.build,
    firstSeen: m.firstSeen,
    runs: m.runs.length,
    ms: m.value,
    hudP95: medOf(m.runs, (r) => r.ui?.p95),
    matrixLast: medOf(m.runs, (r) => r.matrix?.last),
    parityPass: m.runs.filter((r) => r.parity?.pass).length,
  }));
}

export function midwayOf(runs: readonly IMidwayRun[], prdText?: string) {
  const prd = prdText === undefined ? undefined : prdProgress(prdText);
  return {
    kpis: kpisOf(runs, prd),
    prd,
    trends: trendsOf(runs),
    abPairs: abPairsOf(runs),
    breakdown: breakdownOf(runs),
    builds: buildsOf(runs),
    gap: gapOf(runs),
    groups: groupsOf(runs),
    legacyMs: legacyMs(runs),
    runs,
    skipped: runs.reduce((n, r) => n + r.skipped, 0),
    dir: runsDir(),
  };
}

/** Everything the tab shows, read fresh. */
export async function midwayState() {
  return midwayOf(await loadMidwayRuns(), await readFile(PRD, "utf8").catch(() => undefined));
}
